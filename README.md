# Notes about this fork
This is a fork of https://github.com/marc136/snowpack-plugin-elm

This has an alteration from the original snowpack-plugin-elm in that it uses 
[elm-optimize-level-2](https://github.com/mdgriffith/elm-optimize-level-2) for 
production builds over the default Elm compiler optimizations.

Record optimization is turned on by default. This option is not configurable
at the moment. Open an issue if you'd like for this to be configurable.

# Snowpack Elm Plugin (Fork)

This plugin adds support for the [Elm language](https://elm-lang.org) to any Snowpack project.  
With it, you can import \*.elm files and have them compile to JavaScript modules including [Hot Module Replacement (HMR)](https://www.snowpack.dev/concepts/hot-module-replacement).

## Usage

Have a look at [the example folder](https://github.com/marc136/temp-snowpack-plugin-elm/tree/main/example). The interesting bits are the [snowpack configuration](https://github.com/marc136/temp-snowpack-plugin-elm/blob/main/example/snowpack.config.json) and how to import an Elm app in a [.js file](https://github.com/marc136/temp-snowpack-plugin-elm/blob/main/example/src/index.js) or in a [.html file](https://github.com/marc136/temp-snowpack-plugin-elm/blob/main/example/inline.html).

But in general, you will be able to import it like this:

```js
// Both default and named import is supported
import Elm from './Main.elm';
// import { Elm } from './Main.elm';

Elm.Main.init({
  //...
});
```

## Getting started

If this is your first time using Snowpack, please follow [their tutorial](https://www.snowpack.dev/tutorials/getting-started). Or you can just start with `npx snowpack init`.

Install `snowpack-plugin-elm`, for instance with `npm install --save-dev snowpack-plugin-elm` or another node.js package manager.

Then add the plugin to your [Snowpack config, e.g. in `snowpack.config.json`](https://www.snowpack.dev/reference/configuration), either in the simplest way

```json
{
  ...
  "plugins": [
    "snowpack-plugin-elm"
  ],
}
```

or with plugin options

```json
{
  ...
  "plugins": [
    [ "snowpack-plugin-elm", { "debugger": "dev", "optimize": "build" } ]
  ],
}
```

Then you can import your Elm code inside a .html or .js file

```js
import Elm from './Main.elm';
Elm.Main.init({
  node: document.body,
  flags: {},
});
```

## Plugin options

Default values:

```js
{
  "verbose": false,
  // When to enable Elm's time-traveling debugger
  "debugger": "dev", // One of "never", "dev" (only on `snowpack dev`) or "always"
  "optimize": "build", // One of "never", "build" (only on `snowpack build`) or "always"
  "root": "", // same as the `root` folder of the snowpack config
}
```

Note: The Elm `debugger` needs information that is stripped away when using `optimize`, so a setting like `{ "debugger": "always", "optimize": "build" }` would fail and is rejected by the plugin.  
If you want to e.g. have a build with an enabled debugger, you need to use `{ "debugger": "always", "optimize": "never" }`.

## Development

First, clone this repository.

### Tests

Execute `npm test` to start the integration tests and follow the plugin behavior with the test suite.

For more information, set the `verbose` variable to `true`.

### To use it on another project

As described in [this Snowpack guide](https://www.snowpack.dev/guides/plugins#develop-and-test):

1. Clone this repo and `cd` into it.

2. Run `npm link` to expose the plugin globally (in regard to your development machine).

3. Create a new, example Snowpack project in a different location for testing

4. In your example Snowpack project, run `npm install && npm link snowpack-plugin-elm`.

    - Be aware that `npm install` will remove your linked plugin, so on any install, you will need to redo the `npm link snowpack-plugin-elm`.
    - (The alternative would be to use `npm install --save-dev <folder_to_this_repo>`, which would create the "symlink-like" entry in your example Snowpack project’s package.json)

5. In your example Snowpack project, add `snowpack-plugin-elm` to the snowpack.config.json along with any plugin options you’d like to test.