let lastCleanup = 0;
let subscription = global.events.database.connected.subscribe(async (connected) => {
    if (connected) {
        global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.DEBUG, 'EphemeralInit');
        const result = await httpPut({
            mappings: {
                enabled: false
            }
        }, elasticEndpoint + '/ephemeral', 'application/json', elasticHeaders());
        if (global.skyrepoDebug) {
            global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.DEBUG, 'SkyrepoPutInternalEphe', JSON.stringify(result));
        }

        // Throttled cleanup state: only purge expired entries at most once per interval.
        const cleanupIntervalMs = parseInt(process.env.EPHEMERAL_CLEANUP_INTERVAL) || 60000;

        // Fire-and-forget cleanup of expired ephemeral entries.
        // Compares the document version (which stores the expiry timestamp) against the current time.
        function cleanupExpired() {
            const now = Date.now();
            if (now - cleanupIntervalMs < lastCleanup) return;
            lastCleanup = now;
            httpPost({
                "query": {
                    "bool": {
                        "filter": {
                            "script": {
                                "script": {
                                    "source": "doc._version.value < params.param1",
                                    "lang": "painless",
                                    "params": {
                                        "param1": now
                                    }
                                }
                            }
                        }
                    }
                }
            }, elasticEndpoint + '/ephemeral/_delete_by_query', 'application/json', elasticHeaders())
                .then((result) => {
                    global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.DEBUG, 'EphemeralDeleteOld', JSON.stringify(result));
                })
                .catch((err) => {
                    global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.WARNING, 'EphemeralDeleteOldError', err.toString());
                });
        }

        // Ephemeral documents are dehydrated the same way permanent records are:
        // the object is serialized into a single 'data' string field rather than
        // being written out as a nested document. Cached profiles are deep
        // competency trees, so storing them raw lets Elasticsearch's dynamic
        // mapping create a field per property and quickly exhaust the index's
        // total-field limit. Dehydrating bounds every ephemeral document to two
        // fields regardless of the index's mapping state.
        function dehydrate(obj) {
            return {
                data: JSON.stringify(obj),
                writeMs: new Date().getTime(),
            };
        }

        // A document that cannot be rehydrated — such as one written in the raw
        // form used before dehydration — is reported as a miss rather than an
        // error, so the caller simply recomputes. The data is ephemeral by
        // definition, so there is nothing to preserve.
        function rehydrate(source) {
            if (source == null) {
                return source;
            }
            try {
                return JSON.parse(source.data);
            } catch (e) {
                return null;
            }
        }

        global.ephemeral = {
            get: async function (id) {
                cleanupExpired();
                return rehydrate((await httpGet(elasticEndpoint + '/ephemeral/_doc/' + id, 'application/json', elasticHeaders()))["_source"]);
            },
            gets: async function (ids) {
                cleanupExpired();
                if (global.skyrepoDebug) {
                    global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.DEBUG, 'SkyrepManyGetIndexInternal', 'Fetching from ' + index + ' : ' + manyParseParams.length);
                }

                const mget = {};
                const docs = [];
                (mget)['docs'] = docs;

                docs.push(...ids.map(id => ({ _index: 'ephemeral', _id: id })));
                
                let response = await httpPost(mget, elasticEndpoint + '/_mget', 'application/json', false, null, null, true, elasticHeaders());
                response = response?.docs?.map(x => rehydrate(x._source));
                return response || [];
            },
            put: async function (id, obj, until) {
                return await httpPut(dehydrate(obj), elasticEndpoint + '/ephemeral/_doc/' + id + '?version=' + until + '&version_type=external', 'application/json', elasticHeaders());
            },
            delete: async function (id) {
                return await httpDelete(obj, elasticEndpoint + '/ephemeral/_doc/' + id, elasticHeaders())
            },
            deleteWith: async function (partOfId) { 
                let result = await httpPost({
                    "query": {
                        "bool": {
                            "filter": {
                                "script": {
                                    "script": {
                                        "source": "doc._id.value.contains(params.param1)",
                                        "lang": "painless",
                                        "params": {
                                            "param1": partOfId
                                        }
                                    }
                                }
                            }
                        }
                    }
                }, elasticEndpoint + '/ephemeral/_delete_by_query', 'application/json', elasticHeaders());
                global.auditLogger.report(global.auditLogger.LogCategory.NETWORK, global.auditLogger.Severity.DEBUG, 'EphemeralDeleteOld', JSON.stringify(result));
            }
        }

        global.ephemeral.put('test', { test: 'test' }, new Date().getTime() + 10000);

        subscription.unsubscribe();
    }
});
