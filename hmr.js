//////////////////// HMR BEGIN ////////////////////

/*
  MIT License http://www.opensource.org/licenses/mit-license.php
  Original Author: Flux Xu @fluxxu
*/

/*
  A note about the environment that this code runs in...

  assumed globals:
      - `import.meta.hot` (from Snowpack)

  assumed in scope after inserting at the end of the Elm ES Module:
      - `Elm` object that contains the public Elm API
      - various functions defined by Elm which we have to hook such as `_Platform_initialize` and `_Scheduler_binding`
 */

if (import.meta.hot) {
    verbose('found import.meta.hot', import.meta.hot);
    // Elm 0.19.1 introduced a '$' prefix at the beginning of the symbols it emits,
    // and we check for `Maybe.Just` because we expect it to be present in all Elm programs.
    var elmVersion;
    if (typeof elm$core$Maybe$Just !== 'undefined') elmVersion = '0.19.0';
    else if (typeof $elm$core$Maybe$Just !== 'undefined') elmVersion = '0.19.1';
    else throw new Error('Could not determine Elm version');

    function elmSymbol(symbol) {
        try {
            switch (elmVersion) {
                case '0.19.0':
                    return eval(symbol);
                case '0.19.1':
                    return eval('$' + symbol);
                default:
                    throw new Error(
                        'Cannot resolve ' + symbol + '. Elm version unknown!'
                    );
            }
        } catch (e) {
            if (e instanceof ReferenceError) {
                return undefined;
            } else {
                throw e;
            }
        }
    }

    var instances = import.meta.hot.data
        ? import.meta.hot.data.instances || {}
        : {};
    var uid = import.meta.hot.data ? import.meta.hot.data.uid || 0 : 0;

    if (Object.keys(instances).length === 0) {
        console.log('[elm-hot] Enabled');
    }

    var cancellers = [];

    // These 2 variables act as dynamically-scoped variables which are set only when the
    // Elm module's hooked init function is called.
    var initializingInstance = null;
    var swappingInstance = null;

    // TODO check if we have cases where we need to reject this, we can force a browser reload with invalidate
    // See https://github.com/pikapkg/esm-hmr/tree/152fffe555e9281822553b495edbc95ccb6a41b2#usage-example
    import.meta.hot.accept();
    import.meta.hot.dispose(() => {
        console.log('[elm-hot] Dispose old instance');
        if (!import.meta.hot.data) import.meta.hot.data = {};
        import.meta.hot.data.instances = instances;
        import.meta.hot.data.uid = uid;

        // Cleanup pending async tasks

        // First, make sure that no new tasks can be started until we finish replacing the code
        _Scheduler_binding = function () {
            return _Scheduler_fail(new Error('[elm-hot] Inactive Elm instance.'));
        };

        // Second, kill pending tasks belonging to the old instance
        if (cancellers.length) {
            verbose('Killing ' + cancellers.length + ' running processes...');
            try {
                cancellers.forEach(function (cancel) {
                    cancel();
                });
            } catch (e) {
                console.warn('[elm-hot] Kill process error: ' + e.message);
            }
        }
    });

    function verbose(...args) {
        if (import.meta.hot.verbose) {
            args.unshift('[elm-hot]');
            console.log.apply(console, args);
        }
    }

    function getId() {
        return ++uid;
    }

    function findPublicModules(parent, path) {
        var modules = [];
        for (var key in parent) {
            var child = parent[key];
            var currentPath = path ? path + '.' + key : key;
            if ('init' in child) {
                modules.push({
                    path: currentPath,
                    module: child,
                });
            } else {
                modules = modules.concat(findPublicModules(child, currentPath));
            }
        }
        return modules;
    }

    function registerInstance(domNode, flags, path, portSubscribes, portSends) {
        var id = getId();

        var instance = {
            id: id,
            path: path,
            domNode: domNode,
            flags: flags,
            portSubscribes: portSubscribes,
            portSends: portSends,
            lastState: null, // last Elm app state (root model)
        };

        return (instances[id] = instance);
    }

    function isFullscreenApp() {
        // Returns true if the Elm app will take over the entire DOM body.
        return (
            typeof elmSymbol('elm$browser$Browser$application') !== 'undefined' ||
            typeof elmSymbol('elm$browser$Browser$document') !== 'undefined'
        );
    }

    function wrapDomNode(node) {
        // When embedding an Elm app into a specific DOM node, Elm will replace the provided
        // DOM node with the Elm app's content. When the Elm app is compiled normally, the
        // original DOM node is reused (its attributes and content changes, but the object
        // in memory remains the same). But when compiled using `--debug`, Elm will completely
        // destroy the original DOM node and instead replace it with 2 brand new nodes: one
        // for your Elm app's content and the other for the Elm debugger UI. In this case,
        // if you held a reference to the DOM node provided for embedding, it would be orphaned
        // after Elm module initialization.
        //
        // So in order to make both cases consistent and isolate us from changes in how Elm
        // does this, we will insert a dummy node to wrap the node for embedding and hold
        // a reference to the dummy node.
        //
        // We will also put a tag on the dummy node so that the Elm developer knows who went
        // behind their back and rudely put stuff in their DOM.
        var dummyNode = document.createElement('div');
        dummyNode.setAttribute('data-elm-hot', 'true');
        dummyNode.style.height = 'inherit';
        var parentNode = node.parentNode;
        parentNode.replaceChild(dummyNode, node);
        dummyNode.appendChild(node);
        return dummyNode;
    }

    function wrapPublicModule(path, module) {
        var originalInit = module.init;
        if (originalInit) {
            module.init = function (args) {
                var elm;
                var portSubscribes = {};
                var portSends = {};
                var domNode = null;
                var flags = null;
                if (typeof args !== 'undefined') {
                    // normal case
                    domNode =
                        args['node'] && !isFullscreenApp()
                            ? wrapDomNode(args['node'])
                            : document.body;
                    flags = args['flags'];
                } else {
                    // rare case: Elm allows init to be called without any arguments at all
                    domNode = document.body;
                    flags = undefined;
                }
                initializingInstance = registerInstance(
                    domNode,
                    flags,
                    path,
                    portSubscribes,
                    portSends
                );
                elm = originalInit(args);
                wrapPorts(elm, portSubscribes, portSends);
                initializingInstance = null;
                return elm;
            };
        } else {
            console.error('Could not find a public module to wrap at path ' + path);
        }
    }

    function swap(Elm, instance) {
        console.log('[elm-hot] Hot-swapping module: ' + instance.path);

        swappingInstance = instance;

        // remove from the DOM everything that had been created by the old Elm app
        var containerNode = instance.domNode;
        while (containerNode.lastChild) {
            containerNode.removeChild(containerNode.lastChild);
        }

        var m = getAt(instance.path.split('.'), Elm);
        var elm;
        if (m) {
            // prepare to initialize the new Elm module
            var args = { flags: instance.flags };
            if (containerNode === document.body) {
                // fullscreen case: no additional args needed
            } else {
                // embed case: provide a new node for Elm to use
                var nodeForEmbed = document.createElement('div');
                containerNode.appendChild(nodeForEmbed);
                args['node'] = nodeForEmbed;
            }

            elm = m.init(args);

            Object.keys(instance.portSubscribes).forEach(function (portName) {
                if (portName in elm.ports && 'subscribe' in elm.ports[portName]) {
                    var handlers = instance.portSubscribes[portName];
                    if (!handlers.length) {
                        return;
                    }
                    verbose(
                        `Reconnect ${handlers.length} handler(s) to port '${portName}' (${instance.path}).`
                    );
                    handlers.forEach(function (handler) {
                        elm.ports[portName].subscribe(handler);
                    });
                } else {
                    delete instance.portSubscribes[portName];
                    verbose('Port was removed: ' + portName);
                }
            });

            Object.keys(instance.portSends).forEach(function (portName) {
                if (portName in elm.ports && 'send' in elm.ports[portName]) {
                    verbose('Replace old port send with the new send');
                    instance.portSends[portName] = elm.ports[portName].send;
                } else {
                    delete instance.portSends[portName];
                    verbose('Port was removed: ' + portName);
                }
            });
        } else {
            verbose('Module was removed: ' + instance.path);
        }

        swappingInstance = null;
        console.log('[elm-hot] Hot-swapped module: ' + instance.path);
    }

    function wrapPorts(elm, portSubscribes, portSends) {
        var portNames = Object.keys(elm.ports || {});
        //hook ports
        if (portNames.length) {
            // hook outgoing ports
            portNames
                .filter(function (name) {
                    return 'subscribe' in elm.ports[name];
                })
                .forEach(function (portName) {
                    var port = elm.ports[portName];
                    var subscribe = port.subscribe;
                    var unsubscribe = port.unsubscribe;
                    elm.ports[portName] = Object.assign(port, {
                        subscribe: function (handler) {
                            verbose('ports.' + portName + '.subscribe called.');
                            if (!portSubscribes[portName]) {
                                portSubscribes[portName] = [handler];
                            } else {
                                //TODO handle subscribing to single handler more than once?
                                portSubscribes[portName].push(handler);
                            }
                            return subscribe.call(port, handler);
                        },
                        unsubscribe: function (handler) {
                            verbose('ports.' + portName + '.unsubscribe called.');
                            var list = portSubscribes[portName];
                            if (list && list.indexOf(handler) !== -1) {
                                list.splice(list.lastIndexOf(handler), 1);
                            } else {
                                console.warn(
                                    '[elm-hot] ports.' +
                                    portName +
                                    '.unsubscribe: handler not subscribed'
                                );
                            }
                            return unsubscribe.call(port, handler);
                        },
                    });
                });

            // hook incoming ports
            portNames
                .filter(function (name) {
                    return 'send' in elm.ports[name];
                })
                .forEach(function (portName) {
                    var port = elm.ports[portName];
                    portSends[portName] = port.send;
                    elm.ports[portName] = Object.assign(port, {
                        send: function (val) {
                            return portSends[portName].call(port, val);
                        },
                    });
                });
        }
        return portSubscribes;
    }

    /*
      Breadth-first search for a `Browser.Navigation.Key` in the user's app model.
      Returns the key and keypath or null if not found.
    */
    function findNavKey(rootModel) {
        var queue = [];
        if (isDebuggerModel(rootModel)) {
            /*
              Extract the user's app model from the Elm Debugger's model. The Elm debugger
              can hold multiple references to the user's model (e.g. in its "history"). So
              we must be careful to only search within the "state" part of the Debugger.
            */
            queue.push({ value: rootModel['state'], keypath: ['state'] });
        } else {
            queue.push({ value: rootModel, keypath: [] });
        }

        while (queue.length !== 0) {
            var item = queue.shift();

            if (typeof item.value === 'undefined' || item.value === null) {
                continue;
            }

            // The nav key is identified by a runtime tag added by the elm-hot injector.
            if (item.value.hasOwnProperty('elm-hot-nav-key')) {
                // found it!
                return item;
            }

            if (typeof item.value !== 'object') {
                continue;
            }

            for (var propName in item.value) {
                if (!item.value.hasOwnProperty(propName)) continue;
                var newKeypath = item.keypath.slice();
                newKeypath.push(propName);
                queue.push({ value: item.value[propName], keypath: newKeypath });
            }
        }

        return null;
    }

    function isDebuggerModel(model) {
        // Up until elm/browser 1.0.2, the Elm debugger could be identified by a
        // property named "expando". But in version 1.0.2 that was renamed to "expandoModel"
        return (
            model &&
            (model.hasOwnProperty('expando') ||
                model.hasOwnProperty('expandoModel')) &&
            model.hasOwnProperty('state')
        );
    }

    function getAt(keyPath, obj) {
        return keyPath.reduce(function (xs, x) {
            return xs && xs[x] ? xs[x] : null;
        }, obj);
    }

    function removeNavKeyListeners(navKey) {
        window.removeEventListener('popstate', navKey.value);
        window.navigator.userAgent.indexOf('Trident') < 0 ||
        window.removeEventListener('hashchange', navKey.value);
    }

    // hook program creation
    var initialize = _Platform_initialize;
    _Platform_initialize = function (
        flagDecoder,
        args,
        init,
        update,
        subscriptions,
        stepperBuilder
    ) {
        var instance = initializingInstance || swappingInstance;
        var tryFirstRender = !!swappingInstance;

        var hookedInit = function (args) {
            var initialStateTuple = init(args);
            if (swappingInstance) {
                var oldModel = swappingInstance.lastState;
                var newModel = initialStateTuple.a;

                if (
                    typeof elmSymbol('elm$browser$Browser$application') !== 'undefined'
                ) {
                    var oldKeyLoc = findNavKey(oldModel);

                    // attempt to find the Browser.Navigation.Key in the newly-constructed model
                    // and bring it along with the rest of the old data.
                    var newKeyLoc = findNavKey(newModel);
                    var error = null;
                    if (newKeyLoc === null) {
                        error =
                            'could not find Browser.Navigation.Key in the new app model';
                    } else if (oldKeyLoc === null) {
                        error =
                            'could not find Browser.Navigation.Key in the old app model.';
                    } else if (
                        newKeyLoc.keypath.toString() !== oldKeyLoc.keypath.toString()
                    ) {
                        error =
                            'the location of the Browser.Navigation.Key in the model has changed.';
                    } else {
                        // remove event listeners attached to the old nav key
                        removeNavKeyListeners(oldKeyLoc.value);

                        // insert the new nav key into the old model in the exact same location
                        var parentKeyPath = oldKeyLoc.keypath.slice(0, -1);
                        var lastSegment = oldKeyLoc.keypath.slice(-1)[0];
                        var oldParent = getAt(parentKeyPath, oldModel);
                        oldParent[lastSegment] = newKeyLoc.value;
                    }

                    if (error !== null) {
                        console.error(
                            '[elm-hot] Hot-swapping ' +
                            instance.path +
                            ' not possible: ' +
                            error
                        );
                        oldModel = newModel;
                    }
                }

                // the heart of the app state hot-swap
                initialStateTuple.a = oldModel;

                // ignore any Cmds returned by the init during hot-swap
                initialStateTuple.b = elmSymbol('elm$core$Platform$Cmd$none');
            } else {
                // capture the initial state for later
                initializingInstance.lastState = initialStateTuple.a;
            }

            return initialStateTuple;
        };

        var hookedStepperBuilder = function (sendToApp, model) {
            var result;
            // first render may fail if shape of model changed too much
            if (tryFirstRender) {
                tryFirstRender = false;
                try {
                    result = stepperBuilder(sendToApp, model);
                } catch (e) {
                    throw new Error(
                        '[elm-hot] Hot-swapping ' +
                        instance.path +
                        ' is not possible, please reload page. Error: ' +
                        e.message
                    );
                }
            } else {
                result = stepperBuilder(sendToApp, model);
            }

            return function (nextModel, isSync) {
                if (instance) {
                    // capture the state after every step so that later we can restore from it during a hot-swap
                    instance.lastState = nextModel;
                }
                return result(nextModel, isSync);
            };
        };

        return initialize(
            flagDecoder,
            args,
            hookedInit,
            update,
            subscriptions,
            hookedStepperBuilder
        );
    };

    // hook process creation
    var originalBinding = _Scheduler_binding;
    _Scheduler_binding = function (originalCallback) {
        return originalBinding(function () {
            // start the scheduled process, which may return a cancellation function.
            var cancel = originalCallback.apply(this, arguments);
            if (cancel) {
                cancellers.push(cancel);
                return function () {
                    cancellers.splice(cancellers.indexOf(cancel), 1);
                    return cancel();
                };
            }
            return cancel;
        });
    };

    function elmHotInit(Elm) {
        // swap instances
        var removedInstances = [];
        for (var id in instances) {
            var instance = instances[id];
            if (instance.domNode.parentNode) {
                swap(Elm, instance);
            } else {
                removedInstances.push(id);
            }
        }

        removedInstances.forEach(function (id) {
            delete instance[id];
        });

        // wrap all public modules
        var publicModules = findPublicModules(Elm);
        publicModules.forEach(function (m) {
            wrapPublicModule(m.path, m.module);
        });
    }

    elmHotInit(Elm);
}
//////////////////// HMR END ////////////////////
