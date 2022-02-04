const fs = require('fs-extra');
const path = require('path');
const elm = require('node-elm-compiler');
const ElmOptimizeLevel2 = require('elm-optimize-level-2');
// const elmHot = require('elm-hot');

const name = 'elm-plugin';
const prefix = `[${name}]`;

let elmCompilerSingleton = Promise.resolve();

module.exports = (_snowpackConfig, userPluginOptions) => {
    const elmModules = new Map();
    const options = sanitizeOptions(userPluginOptions);

    return {
        name,
        resolve: { input: ['.elm'], output: ['.js'] },
        options,

        config(snowpackConfig) {
            // snowpack config was built and can be accessed here
            // https://www.snowpack.dev/guides/plugins#config()
            // if (options.verbose) console.info(prefix, 'snowpackConfig', snowpackConfig);
            options.root = options.root
                ? path.join(snowpackConfig.root, options.root)
                : snowpackConfig.root;
        },

        async load({ filePath, isDev, isHmrEnabled }) {
            const file = rel(filePath);
            if (options.verbose) {
                console.info(prefix, 'aquiring lock to compile', file);
            }
            const releaseLock = await aquireLock();
            if (options.verbose) {
                console.info(prefix, 'aquired lock to compile', file);
            }

            if (options.verbose) {
                const args = { file, isDev, isHmrEnabled };
                console.info(prefix, 'load', args);
            }

            try {
                const result = await compile(filePath, isDev, isHmrEnabled, options);

                if (isHmrEnabled) {
                    // We don't need to wait for this to finish
                    storeDependenciesForHmr(filePath, elmModules).then(deps => {
                        if (options.verbose) {
                            console.info(prefix, file, 'imports', deps.map(rel));
                        }
                    });
                }
                releaseLock();
                return result;
            } catch (ex) {
                releaseLock();
                throw ex;
            }
        },

        async onChange({ filePath }) {
            const modules = elmModules.get(filePath);
            if (!modules) return;
            modules.forEach(module => {
                if (options.verbose) {
                    console.info(
                        prefix,
                        `Will compile ${rel(module)} because ${rel(filePath)} was changed`
                    );
                }
                if (typeof this.markChanged === 'function') this.markChanged(module);
            });
        },
    };
};

function sanitizeOptions(userPluginOptions) {
    const defaultOptions = {
        verbose: false,
        debugger: 'dev',
        optimize: 'build',
        root: undefined,
    };
    const options = { ...defaultOptions, ...userPluginOptions };

    function mustBeOneOf(key, allowed) {
        if (!allowed.includes(options[key])) {
            const current = `"${key}": "${options[key]}"`;
            const expected = `Should be one of "${allowed.join('", "')}".`;
            throw new Error(`${prefix} Invalid option '${current}'. ${expected}`);
        }
    }

    mustBeOneOf('debugger', ['never', 'dev', 'always']);
    mustBeOneOf('optimize', ['never', 'build', 'always']);

    if (
        (options.debugger === 'always' && options.optimize !== 'never') ||
        (options.optimize === 'always' && options.debugger !== 'never')
    ) {
        const err = `debugger="${options.debugger}" and optimize="${options.optimize}"`;
        throw new Error(`${prefix} Invalid option combination ${err}.`);
    }

    return options;
}

/**
 * Shortens an absolute path to a relative one
 * @param {string} filePath
 */
function rel(filePath) {
    return path.relative(process.cwd(), filePath);
}

async function compile(filePath, isDev, isHmrEnabled, options) {
    const debug =
        options.debugger === 'always' || (isDev && options.debugger === 'dev');
    const optimize =
        options.optimize === 'always' || (!isDev && options.optimize === 'build');

    const file = path.relative(options.root, filePath);

    let iife = await elm
        .compileToString([file], { debug, optimize, cwd: options.root })
        .catch(err => {
            // Snowpack tries to compile all .elm files, but the compiler needs an exposed `main`.
            // We only need to compile the main files, the compiler will resolve dependencies.
            const ERROR_NO_MAIN = '-- NO MAIN --';
            if (!isDev && err.message.includes(ERROR_NO_MAIN)) return;

            throw err;
        });

    if (!iife) return;

    // custom code - the alteration from the original snowpack-plugin-elm
    if (optimize) {
        iife = await ElmOptimizeLevel2.transform(iife, true);
    }
    // end custom code

    if (isHmrEnabled) {
        return toHMR(iife, options, optimize);
    } else {
        return toESM(iife, optimize);
    }
}

async function toHMR(step0, options, optimize) {
    const debug = true;
    async function writeDebug(name, content) {
        if (!debug) return;
        return fs.writeFile(path.join(__dirname, '.temp', name), content);
    }
    if (debug) await fs.ensureDir(path.join(__dirname, '.temp'));
    await writeDebug('step0.js', step0);

    const step1 = toESM(step0, optimize);
    await writeDebug('step1.js', step1);

    const step2 = await elmHotInject(step1, options);
    await writeDebug('step2.js', step2);

    return step2;
}

/**
 * Inject the HMR code into the Elm compiler's JS output
 * @param {string} originalElmCodeJS
 */
async function elmHotInject(originalElmCodeJS, options) {
    // copied from https://github.com/klazuka/elm-hot/blob/efe9db967496415944246006b4e711c0aed1e777/src/inject.js

    const hmrCode = await fs.readFile(path.join(__dirname, 'hmr.js'), {
        encoding: 'utf8',
    });

    // first, verify that we have not been given Elm 0.18 code
    if (
        originalElmCodeJS.indexOf('_elm_lang$core$Native_Platform.initialize') >= 0
    ) {
        throw new Error(
            '[elm-hot] Elm 0.18 is not supported. Please use fluxxu/elm-hot-loader@0.5.x instead.'
        );
    }

    let modifiedCode = originalElmCodeJS;

    if (originalElmCodeJS.indexOf('elm$browser$Browser$application') !== -1) {
        // attach a tag to Browser.Navigation.Key values. It's not really fair to call this a hack
        // as this entire project is a hack, but this is evil evil evil. We need to be able to find
        // the Browser.Navigation.Key in a user's model so that we do not swap out the new one for
        // the old. But as currently implemented (2018-08-19), there's no good way to detect it.
        // So we will add a property to the key immediately after it's created so that we can find it.
        const navKeyDefinition = /var\s+key\s*=\s*function\s*\(\)\s*{\s*key.a\(\s*onUrlChange\(\s*_Browser_getUrl\(\)\s*\)\s*\);\s*};/;
        function replacementString(match) {
            return match + '\n' + "key['elm-hot-nav-key'] = true;";
        }
        modifiedCode = originalElmCodeJS.replace(
            navKeyDefinition,
            replacementString
        );
        if (modifiedCode === originalElmCodeJS) {
            throw new Error(
                '[elm-hot] Browser.Navigation.Key def not found. Version mismatch?'
            );
        }
    }

    return (
        modifiedCode +
        '\n\n' +
        `if (import.meta) import.meta.verbose = ${options.verbose}` +
        hmrCode
    );
}

/**
 * CUSTOM CODE
 * Transforms the IIFE the elm compiler returns to an ES module
 * @param {string} iife - the js source code emitted from the elm compiler
 */
function toESM(iife, optimize) {
    // custom code start
    const startString = optimize ? 'function $$Record1(' : 'function F(';
    const endString = optimize ? ');\n}' : ');}';
    // custom code end

    // 1. Remove `(function(scope){\n"use strict";\n\n` at the beginning
    const start = iife.indexOf(startString);
    // 2. Remove `);}(this));` at the end
    const end = iife.lastIndexOf(endString);

    return (
        iife
            .slice(start, end)
            // Executing function `_Platform_export` is not needed in an ESModule
            .replace('_Platform_export({', 'export const Elm = {')
            .concat(';\nexport default Elm;\n')
    );
}

/**
 * @param {string} filePath - an Elm module
 * @param {Map<string, Set<string>>} elmModules - map of all known Elm modules and Set of other modules that import the key module
 */
async function storeDependenciesForHmr(filePath, elmModules) {
    const deps = await elm.findAllDependencies(filePath);
    deps.forEach(depFilePath => {
        const known = elmModules.get(depFilePath) || new Set();
        known.add(filePath);
        elmModules.set(depFilePath, known);
    });
    return deps;
}

/**
 * The Elm compiler may only run once in the same folder at any given moment.
 * If it runs multiple time, it will corrupt the elm-stuff folder for the other Elm compiler
 * processes.
 *
 * This lock guarantees the sequential compilation of all Elm files.
 */
async function aquireLock() {
    let release;
    const before = elmCompilerSingleton;
    elmCompilerSingleton = new Promise(resolve => {
        release = resolve;
    });
    await before;
    return release;
}
