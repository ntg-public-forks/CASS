const loopback = require('../../shims/cassproject.js');

const moodleConfigPaths = ["etc/adapter.moodle.json", "/app/etc/adapter.moodle.json"];
let cachedConfig = null;

function getMoodleConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }
    let config = null;
    for (let p of moodleConfigPaths) {
        if (fileExists(p)) {
            try {
                let text = fileToString(fileLoad(p));
                let fileData = JSON.parse(text);
                if (fileData.moodleToken && fileData.moodleEndpoint) {
                    config = {
                        moodleToken: fileData.moodleToken,
                        moodleEndpoint: fileData.moodleEndpoint
                    };
                    console.log("[Moodle Adapter] Successfully loaded configuration from: " + p);
                    break;
                }
            } catch (e) {
                console.error("[Moodle Adapter] Failed to parse Moodle config file at " + p, e);
            }
        }
    }
    cachedConfig = config;
    return config;
}
function getGuid(id) {
    if (!id) return id;
    let cleaned = id.replace(/\/+$/, "");
    let parts = cleaned.split("/");
    let last = parts[parts.length - 1];
    if (/^\d+$/.test(last) && parts.length > 1) {
        return parts[parts.length - 2];
    }
    return last;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getRequiredConfig() {
    let config = getMoodleConfig();
    if (!config) {
        error("Moodle adapter configuration missing", 500);
    }
    return config;
}

function setupAdapterIdentity() {
    let adapterKey = process.env.MOODLE_ADAPTER_PPK || keyFor("adapter.moodle.private");
    let identity = new EcIdentity();
    identity.displayName = "Moodle Adapter Identity";
    identity.ppk = EcPpk.fromPem(adapterKey);
    EcIdentityManager.default.addIdentity(identity);
    return identity;
}

function cassUriFromGuid(guid) {
    let base = global.repo.selectedServer;
    if (!base.endsWith("/")) {
        base += "/";
    }
    return base + "data/" + guid;
}

function truncateName(name, description) {
    let truncatedName = name || "Unnamed";
    let formattedDescription = description || "";
    if (truncatedName.length > 100) {
        formattedDescription = truncatedName + (formattedDescription ? "\n\n" + formattedDescription : "");
        truncatedName = truncatedName.substring(0, 97) + "...";
    }
    return {
        name: truncatedName,
        description: formattedDescription
    };
}

function serializeError(e) {
    if (!e) return "Sync failed.";
    if (typeof e === "string") return e;
    if (e.message) return e.message;
    if (e.data) {
        if (typeof e.data === "string") return e.data;
        if (e.data.message) return e.data.message;
        try {
            return JSON.stringify(e.data);
        } catch (err) { }
    }
    try {
        return JSON.stringify(e);
    } catch (jsonErr) {
        return String(e);
    }
}

function buildQueryString(obj, prefix) {
    let str = [];
    for (let p in obj) {
        if (obj.hasOwnProperty(p)) {
            let k = prefix ? prefix + "[" + p + "]" : p;
            let v = obj[p];
            if (v !== null && typeof v === "object") {
                str.push(buildQueryString(v, k));
            } else if (v !== undefined && v !== null) {
                str.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
            }
        }
    }
    return str.filter(s => s).join("&");
}

async function moodleCall(wsfunction, params) {
    let config = getRequiredConfig();
    let allParams = {
        wstoken: config.moodleToken,
        wsfunction: wsfunction,
        moodlewsrestformat: 'json',
        ...params
    };

    let postData = buildQueryString(allParams);
    let url = config.moodleEndpoint;

    try {
        let response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: postData,
            signal: AbortSignal.timeout(10000)
        });

        let text = await response.text();
        let result = text;
        try {
            result = JSON.parse(text);
        } catch (e) {

        }

        if (result && result.exception) {
            console.error("[Moodle Adapter] Moodle returned API exception: " + result.message);
            throw {
                message: result.message,
                data: result
            };
        }

        if (!response.ok) {
            console.error("[Moodle Adapter] HTTP error " + response.status + ": " + response.statusText);
            throw {
                message: "HTTP error " + response.status + ": " + response.statusText,
                data: result
            };
        }

        return result;
    } catch (err) {
        console.error("[Moodle Adapter] Fetch call to Moodle failed for function " + wsfunction, err);
        throw err;
    }
}


async function moodleSyncPush(guid, contextId) {
    let config = getRequiredConfig();

    if (!guid || !UUID_REGEX.test(guid)) {
        error("Invalid framework GUID: " + guid + ". Only 36-character UUIDs are allowed.", 400);
    }

    let resolvedContextId = contextId || config.moodleContextId || 1;
    console.log("[Moodle Adapter] Starting sync push for framework GUID: " + guid);

    setupAdapterIdentity();

    let framework = null;
    let fullUri = cassUriFromGuid(guid);

    try {
        framework = await loopback.frameworkGet(fullUri);
    } catch (fetchError) {

    }

    if (!framework) {
        console.error("[Moodle Adapter] Framework not found: " + guid + " (URI checked: " + fullUri + ")");
        error("Framework not found: " + guid, 404);
    }

    let competencies = [];
    if (framework.competency && framework.competency.length > 0) {
        let compResults = await Promise.all(
            framework.competency.map(cid => loopback.competencyGet(cid).catch(() => null))
        );
        competencies = compResults.filter(Boolean);
    }

    let relations = [];
    if (framework.relation && framework.relation.length > 0) {
        let relResults = await Promise.all(
            framework.relation.map(rid => loopback.alignmentGet(rid).catch(() => null))
        );
        relations = relResults.filter(Boolean);
    }

    let parentMap = {};
    let childrenMap = {};
    for (let rel of relations) {
        if (rel.relationType === "narrows" || (typeof Relation !== "undefined" && rel.relationType === Relation.NARROWS)) {
            let parent = rel.target;
            let child = rel.source;
            parentMap[child] = parent;
            if (!childrenMap[parent]) {
                childrenMap[parent] = [];
            }
            childrenMap[parent].push(child);
        }
    }


    let rootCompetencies = competencies.filter(c => {
        let parentId = parentMap[c.shortId()] || parentMap[c.id];
        return !parentId || !framework.competency.includes(parentId);
    });


    let moodleFrameworkId = null;
    let listResponse = await moodleCall("core_competency_list_competency_frameworks", {
        context: {
            contextid: resolvedContextId
        }
    });

    if (listResponse && Array.isArray(listResponse)) {
        for (let f of listResponse) {
            if (f.idnumber === guid || f.idnumber === getGuid(framework.shortId())) {
                moodleFrameworkId = f.id;
                break;
            }
        }
    }

    let resolvedScaleId = config.scaleid || 2;
    let defaultScaleConfig = JSON.stringify([
        { scaleid: resolvedScaleId },
        { id: 1, scaledefault: 1, proficient: 0 },
        { id: 2, scaledefault: 0, proficient: 1 }
    ]);

    let { name: fwName, description: fwDescription } = truncateName(framework.name || "Unnamed Framework", framework.description);

    let frameworkData = {
        shortname: fwName,
        description: fwDescription,
        descriptionformat: 1,
        idnumber: guid,
        visible: 1,
        scaleid: resolvedScaleId,
        scaleconfiguration: config.scaleconfiguration || defaultScaleConfig,
        contextid: resolvedContextId
    };

    if (moodleFrameworkId) {
        console.log("[Moodle Adapter] Updating existing Moodle framework (ID: " + moodleFrameworkId + ")");
        frameworkData.id = moodleFrameworkId;
        await moodleCall("core_competency_update_competency_framework", {
            competencyframework: frameworkData
        });
    } else {
        console.log("[Moodle Adapter] Creating new Moodle framework...");
        let createResponse = await moodleCall("core_competency_create_competency_framework", {
            competencyframework: frameworkData
        });
        moodleFrameworkId = createResponse.id;
    }


    let existingMoodleCompetencies = await moodleCall("core_competency_list_competencies", {
        filters: [
            {
                column: "competencyframeworkid",
                value: String(moodleFrameworkId)
            }
        ]
    });

    let existingCompMap = {};
    if (existingMoodleCompetencies && Array.isArray(existingMoodleCompetencies)) {
        for (let mc of existingMoodleCompetencies) {
            if (mc.idnumber) {
                existingCompMap[mc.idnumber] = mc.id;
            }
        }
    }

    let createdCount = 0;
    let updatedCount = 0;


    async function pushCompetency(comp, parentMoodleId) {
        let compIdnumber = getGuid(comp.shortId());
        let existingMoodleId = existingCompMap[compIdnumber];
        let currentMoodleId = null;

        let { name: compName, description: compDescription } = truncateName(comp.name || "Unnamed Competency", comp.description);

        let competencyData = {
            shortname: compName,
            description: compDescription,
            descriptionformat: 1,
            competencyframeworkid: moodleFrameworkId,
            parentid: parentMoodleId || 0
        };

        if (existingMoodleId) {
            competencyData.id = existingMoodleId;
            await moodleCall("core_competency_update_competency", {
                competency: competencyData
            });
            currentMoodleId = existingMoodleId;
            updatedCount++;
        } else {
            competencyData.idnumber = compIdnumber;
            let createCompResponse = await moodleCall("core_competency_create_competency", {
                competency: competencyData
            });
            currentMoodleId = createCompResponse.id;
            existingCompMap[compIdnumber] = currentMoodleId;
            createdCount++;
        }


        let childrenIds = childrenMap[comp.shortId()] || childrenMap[comp.id] || [];
        for (let childId of childrenIds) {
            let childComp = competencies.find(c => c.shortId() === childId || c.id === childId);
            if (childComp) {
                await pushCompetency(childComp, currentMoodleId);
            }
        }
    }


    for (let rootComp of rootCompetencies) {
        await pushCompetency(rootComp, 0);
    }

    console.log("[Moodle Adapter] Sync push completed! Created: " + createdCount + ", Updated: " + updatedCount);

    return JSON.stringify({
        success: true,
        message: "Successfully pushed framework to Moodle",
        moodleFrameworkId: moodleFrameworkId,
        stats: {
            competenciesCreated: createdCount,
            competenciesUpdated: updatedCount
        }
    });
}

async function moodleSyncPull(guid, contextId) {
    let config = getRequiredConfig();


    if (!guid || !UUID_REGEX.test(guid)) {
        error("Invalid framework GUID: " + guid + ". Only 36-character UUIDs are allowed.", 400);
    }

    let resolvedContextId = contextId || config.moodleContextId || 1;
    let frameworkId = null;

    let listResponse = await moodleCall("core_competency_list_competency_frameworks", {
        context: {
            contextid: resolvedContextId
        }
    });

    if (listResponse && Array.isArray(listResponse)) {
        for (let f of listResponse) {
            if (f.idnumber === guid) {
                frameworkId = f.id;
                break;
            }
        }
    }

    if (!frameworkId) {
        error("No Moodle competency framework found with CASS ID: " + guid, 404);
    }

    let identity = setupAdapterIdentity();


    let moodleFramework = null;
    try {
        moodleFramework = await moodleCall("core_competency_read_competency_framework", {
            id: frameworkId
        });
    } catch (e) {
        error("Failed to read Moodle competency framework: " + (e.message || e), 404);
    }

    if (!moodleFramework) {
        error("Moodle competency framework not found: " + frameworkId, 404);
    }


    let framework = null;
    let isNewFramework = false;
    guid = moodleFramework.idnumber || guid;

    if (guid && guid.length === 36) {
        let fullUri = cassUriFromGuid(guid);
        try {
            framework = await loopback.frameworkGet(fullUri);
        } catch (e) {

        }
    }

    if (!framework) {
        framework = new EcFramework();
        framework.generateId(global.repo.selectedServer);
        isNewFramework = true;
        guid = getGuid(framework.shortId());
    }


    framework.name = moodleFramework.shortname || "Unnamed Framework";
    framework.description = moodleFramework.description || "";
    if (framework.competency == null) framework.competency = [];
    if (framework.relation == null) framework.relation = [];


    if (isNewFramework) {
        framework.addOwner(identity.ppk.toPem());
    }

    let objectsToSave = [framework];
    let moodleIdnumbersUpdatedCount = 0;


    if (moodleFramework.idnumber !== guid) {
        try {
            await moodleCall("core_competency_update_competency_framework", {
                competencyframework: {
                    id: frameworkId,
                    idnumber: guid
                }
            });
            moodleIdnumbersUpdatedCount++;
        } catch (updateError) {
            console.error("[Moodle Adapter] Failed to update Moodle framework idnumber", updateError);
        }
    }


    let moodleCompetencies = [];
    try {
        moodleCompetencies = await moodleCall("core_competency_list_competencies", {
            filters: [
                {
                    column: "competencyframeworkid",
                    value: String(frameworkId)
                }
            ]
        });
    } catch (e) {
        console.error("[Moodle Adapter] Error listing competencies from Moodle", e);
        error("Failed to list Moodle competencies: " + (e.message || e), 500);
    }

    let competenciesCreatedCount = 0;
    let competenciesUpdatedCount = 0;


    let moodleToCassCompMap = {};


    for (let mc of moodleCompetencies) {
        let comp = null;
        let isNewComp = false;
        let compGuid = mc.idnumber;

        if (compGuid && compGuid.length === 36) {
            let fullUri = cassUriFromGuid(compGuid);
            try {
                comp = await loopback.competencyGet(fullUri);
            } catch (e) {

            }
        }

        if (!comp) {
            comp = new EcCompetency();
            comp.generateId(global.repo.selectedServer);
            isNewComp = true;
            compGuid = getGuid(comp.shortId());
        }


        let name = mc.shortname;
        let description = mc.description || "";


        if (description.includes("\n\n")) {
            let descriptionParts = description.split("\n\n");
            let potentialFullName = descriptionParts[0];

            let truncatedPrefix = mc.shortname;
            if (truncatedPrefix.endsWith("...")) {
                truncatedPrefix = truncatedPrefix.substring(0, truncatedPrefix.length - 3);
            }
            if (potentialFullName.startsWith(truncatedPrefix)) {
                name = potentialFullName;
                description = descriptionParts.slice(1).join("\n\n");
            }
        }

        comp.name = name;
        comp.description = description;

        if (isNewComp) {
            comp.addOwner(identity.ppk.toPem());
            competenciesCreatedCount++;
        } else {
            competenciesUpdatedCount++;
        }

        objectsToSave.push(comp);
        moodleToCassCompMap[mc.id] = comp;


        if (mc.idnumber !== compGuid) {
            try {
                await moodleCall("core_competency_update_competency", {
                    competency: {
                        id: mc.id,
                        idnumber: compGuid
                    }
                });
                moodleIdnumbersUpdatedCount++;
            } catch (compUpdateError) {
                console.error("[Moodle Adapter] Failed to update Moodle competency idnumber", compUpdateError);
            }
        }


        if (!framework.competency.includes(comp.shortId()) && !framework.competency.includes(comp.id)) {
            framework.competency.push(comp.shortId());
        }
    }



    let existingRelations = [];
    if (framework.relation && framework.relation.length > 0) {
        let relResults = await Promise.all(
            framework.relation.map(rid => loopback.alignmentGet(rid).catch(() => null))
        );
        existingRelations = relResults.filter(Boolean);
    }

    for (let mc of moodleCompetencies) {
        if (mc.parentid && mc.parentid > 0) {
            let childComp = moodleToCassCompMap[mc.id];
            let parentComp = moodleToCassCompMap[mc.parentid];

            if (childComp && parentComp) {
                let sourceUri = childComp.shortId();
                let targetUri = parentComp.shortId();

                let relationExists = existingRelations.some(r =>
                    (r.relationType === "narrows" || (typeof Relation !== "undefined" && r.relationType === Relation.NARROWS)) &&
                    (r.source === sourceUri || r.source === childComp.id) &&
                    (r.target === targetUri || r.target === parentComp.id)
                );

                if (!relationExists) {
                    let alignment = new EcAlignment();
                    alignment.generateId(global.repo.selectedServer);
                    alignment.relationType = "narrows";
                    alignment.source = sourceUri;
                    alignment.target = targetUri;
                    alignment.addOwner(identity.ppk.toPem());

                    objectsToSave.push(alignment);
                    framework.relation.push(alignment.shortId());
                }
            }
        }
    }


    try {
        await loopback.multiput(global.repo, objectsToSave);
    } catch (saveError) {
        console.error("[Moodle Adapter] Error batch saving objects to CaSS", saveError);
        error("Failed to persist sync objects to CaSS repository: " + (saveError.message || saveError), 500);
    }

    console.log("[Moodle Adapter] Sync pull completed successfully!");
    return JSON.stringify({
        success: true,
        message: "Successfully pulled framework from Moodle",
        cassFrameworkUri: framework.shortId(),
        stats: {
            competenciesCreated: competenciesCreatedCount,
            competenciesUpdated: competenciesUpdatedCount,
            moodleIdnumbersUpdated: moodleIdnumbersUpdatedCount
        }
    });
}

async function moodlePush() {
    let body = this.dataStreams?.body || this.dataStreams?.data;
    let id = this.params.id || body?.id;
    let contextId = this.params.contextid ? parseInt(this.params.contextid) : (body?.contextid ? parseInt(body.contextid) : null);

    if (!id) {
        error("Missing required parameter: id", 400);
    }

    try {
        return await moodleSyncPush(id, contextId);
    } catch (e) {
        console.error("[Moodle Adapter] Push error: ", e);
        return JSON.stringify({
            success: false,
            message: "Push failed.",
            error: serializeError(e)
        });
    }
}

async function moodlePull() {
    let body = this.dataStreams?.body || this.dataStreams?.data;
    let id = this.params.id || body?.id;
    let contextId = this.params.contextid ? parseInt(this.params.contextid) : (body?.contextid ? parseInt(body.contextid) : null);

    if (!id) {
        error("Missing required parameter: id", 400);
    }

    try {
        return await moodleSyncPull(id, contextId);
    } catch (e) {
        console.error("[Moodle Adapter] Pull error: ", e);
        return JSON.stringify({
            success: false,
            message: "Pull failed.",
            error: serializeError(e)
        });
    }
}


if (!global.disabledAdapters['moodle']) {
    let config = getMoodleConfig();
    if (!config) {
        console.log("Moodle Adapter Warning: Config file (adapter.moodle.json) is missing or invalid. Adapter will be inactive.");
    } else {
        console.log("Moodle Adapter: Successfully loaded configuration. Registering endpoints...");

        /**
         * @openapi
         * /api/moodle/push:
         *   post:
         *     tags:
         *       - Moodle Adapter
         *     summary: Push CaSS framework to Moodle
         *     description: Pushes a competency framework and its child competencies from CaSS to Moodle.
         *     parameters:
         *       - in: query
         *         name: id
         *         schema:
         *           type: string
         *         description: The 36-character GUID of the CaSS framework to push.
         *       - in: query
         *         name: contextid
         *         schema:
         *           type: integer
         *         description: Optional context ID where the framework should be created in Moodle (defaults to configuration or 1).
         *     requestBody:
         *       content:
         *         application/json:
         *           schema:
         *             type: object
         *             properties:
         *               id:
         *                 type: string
         *                 description: The 36-character GUID of the CaSS framework to push.
         *               contextid:
         *                 type: integer
         *                 description: Optional context ID in Moodle.
         *     responses:
         *       200:
         *         description: Push result summary
         *         content:
         *           application/json:
         *             schema:
         *               type: object
         */
        bindWebService("/moodle/push", moodlePush);

        /**
         * @openapi
         * /api/moodle/pull:
         *   post:
         *     tags:
         *       - Moodle Adapter
         *     summary: Pull framework from Moodle into CaSS
         *     description: Pulls a competency framework and its child competencies from Moodle into CaSS.
         *     parameters:
         *       - in: query
         *         name: id
         *         schema:
         *           type: string
         *         description: The 36-character GUID of the framework to pull.
         *       - in: query
         *         name: contextid
         *         schema:
         *           type: integer
         *         description: Optional context ID where the framework resides in Moodle (defaults to configuration or 1).
         *     requestBody:
         *       content:
         *         application/json:
         *           schema:
         *             type: object
         *             properties:
         *               id:
         *                 type: string
         *                 description: The 36-character GUID of the framework to pull.
         *               contextid:
         *                 type: integer
         *                 description: Optional context ID in Moodle.
         *     responses:
         *       200:
         *         description: Pull result summary
         *         content:
         *           application/json:
         *             schema:
         *               type: object
         */
        bindWebService("/moodle/pull", moodlePull);
    }
}
