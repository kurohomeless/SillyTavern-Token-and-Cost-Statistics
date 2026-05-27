import {
    eventSource,
    event_types,
    main_api,
    streamingProcessor,
    saveSettingsDebounced,
    getGeneratingModel,
} from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import {
    getTokenCountAsync,
    getTextTokens,
    getFriendlyTokenizerName,
    tokenizers,
} from "../../../tokenizers.js";

const EXT_KEY = "kuro-token-analytics";
const moment = window.SillyTavern?.libs?.moment || window.moment;

// --- State & Database ---

const DEFAULT_DB = {
    version: 1,
    models: {}, // { "model_id": { color: "#hex", priceIn: 0, priceOut: 0 } }
    records: {
        hourly: {}, // "YYYY-MM-DDTHH"
        daily: {}, // "YYYY-MM-DD"
        monthly: {}, // "YYYY-MM"
    },
};

let db = null;
let currentView = "24H"; // '24H', '7D', '30D', '1Y', 'ALL'
let tooltipEl = null;
let globalResizeObserver = null;
let resizeDebounceTimeout = null;
let connectionManagerPatchInterval = null;
let isTrackingBackground = false;

const activeGenerations = new Map();

// Defensive Prototype Pollution Check
function isValidModelId(mId) {
    if (typeof mId !== "string") return false;
    return !/^(?:__proto__|prototype|constructor)$/i.test(mId.trim());
}

/**
 * Fallback date formatter in case moment library is not bundled on a custom build/fork.
 */
function formatDateKey(dateObj, formatStr) {
    if (moment) {
        return moment(dateObj).format(formatStr);
    }
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    const h = String(dateObj.getHours()).padStart(2, "0");
    if (formatStr === "YYYY-MM-DD[T]HH") return `${y}-${m}-${d}T${h}`;
    if (formatStr === "YYYY-MM-DD") return `${y}-${m}-${d}`;
    if (formatStr === "YYYY-MM") return `${y}-${m}`;
    return `${y}-${m}-${d}`;
}

/**
 * Normalizes fully-qualified model IDs down to their root name 
 * to allow color & price config sharing across similar model tags.
 */
function getNormalizedModelId(modelId) {
    if (!modelId || typeof modelId !== "string") return "unknown";
    let norm = modelId.toLowerCase().trim();
    norm = norm.replace(/^(?:openai|anthropic|google|cohere|mistral|openrouter|meta|deepseek)\//i, "");
    norm = norm.replace(/:(?:beta|free|instruct|chat|thinking|reasoning|preview)$/i, "");
    return norm;
}

function initDB() {
    extension_settings[EXT_KEY] ??= structuredClone(DEFAULT_DB);
    db = extension_settings[EXT_KEY];

    db.records ??= { hourly: {}, daily: {}, monthly: {} };
    db.models ??= {};

    pruneDatabase();
}

/**
 * Prunes old data to prevent settings.json bloat.
 * Hourly kept for 7 days. Daily kept for 365 days. Monthly kept forever.
 */
function pruneDatabase() {
    const now = Date.now();
    const DAY_MS = 86400000;
    let changed = false;
    const usedModels = new Set();

    for (const key in db.records.hourly) {
        const [datePart, hourPart] = key.split("T");
        const [y, m, d] = datePart.split("-");
        const ts = new Date(y, m - 1, d, hourPart, 0, 0).getTime();
        if (now - ts > 7 * DAY_MS) {
            delete db.records.hourly[key];
            changed = true;
        } else {
            Object.keys(db.records.hourly[key].models).forEach((mId) => {
                if (isValidModelId(mId)) usedModels.add(mId);
            });
        }
    }

    for (const key in db.records.daily) {
        const [y, m, d] = key.split("-");
        const ts = new Date(y, m - 1, d, 0, 0, 0).getTime();
        if (now - ts > 365 * DAY_MS) {
            delete db.records.daily[key];
            changed = true;
        } else {
            Object.keys(db.records.daily[key].models).forEach((mId) => {
                if (isValidModelId(mId)) usedModels.add(mId);
            });
        }
    }

    for (const key in db.records.monthly) {
        Object.keys(db.records.monthly[key].models).forEach((mId) => {
            if (isValidModelId(mId)) usedModels.add(mId);
        });
    }

    for (const mId in db.models) {
        if (!usedModels.has(mId)) {
            delete db.models[mId];
            changed = true;
        }
    }

    if (changed) saveSettingsDebounced();
}

// --- Security Helper ---

const escapeHtml = (str) => {
    if (typeof str !== "string") return "";
    return str.replace(
        /[&<>"']/g,
        (m) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#039;",
            })[m],
    );
};

// --- Token Counting Engine ---

async function countTokens(text) {
    if (!text || typeof text !== "string")
        return { count: 0, estimated: false };
    try {
        const { tokenizerId } = getFriendlyTokenizerName(main_api);
        const type = main_api === "openai" ? tokenizers.OPENAI : tokenizerId;
        const ids = getTextTokens(type, text);
        if (Array.isArray(ids) && ids.length > 0)
            return { count: ids.length, estimated: false };

        const count = await getTokenCountAsync(text);
        return { count, estimated: false };
    } catch (e) {
        const divisor = /[^\x00-\x7F]/.test(text) ? 1.8 : 3.35;
        return { count: Math.ceil(text.length / divisor), estimated: true };
    }
}

async function calculateInputPayload(promptData) {
    let total = 0;
    let isEstimated = false;

    const add = async (text) => {
        const res = await countTokens(text);
        total += res.count;
        if (res.estimated) isEstimated = true;
    };

    if (typeof promptData === "string") {
        await add(promptData);
    } else if (Array.isArray(promptData)) {
        for (const msg of promptData) {
            if (typeof msg.content === "string") await add(msg.content);
            else if (Array.isArray(msg.content)) {
                for (const p of msg.content) {
                    if (p.type === "text" && p.text) await add(p.text);
                    if (p.type === "image_url") total += 765;
                }
            }
            if (msg.role) total += 1;
            if (msg.name) await add(msg.name);
        }
        total += promptData.length * 3;
    }
    return { count: total, estimated: isEstimated };
}

/**
 * Extracts native API-reported token payloads saved by ST Core.
 */
function parseApiUsage(apiUsage) {
    if (!apiUsage || typeof apiUsage !== 'object') return null;

    const readNumber = (...values) => {
        for (const value of values) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    };

    const input = readNumber(
        apiUsage.prompt_tokens,
        apiUsage.input_tokens,
        apiUsage.promptTokenCount,
    );
    const output = readNumber(
        apiUsage.completion_tokens,
        apiUsage.output_tokens,
        apiUsage.candidatesTokenCount,
    );
    const total = readNumber(
        apiUsage.total_tokens,
        apiUsage.totalTokenCount,
        input !== null && output !== null ? input + output : null,
    );

    if (input === null && output === null && total === null) return null;

    return {
        input: input || 0,
        output: output || 0,
        total: total || (input || 0) + (output || 0)
    };
}

// --- Event Handlers ---

async function handleGenerationStarted(type, params, isDryRun) {
    const key = isDryRun ? "dryRun" : "main";

    // Flush any lingering quiet generation before proceeding
    const oldGen = activeGenerations.get(key);
    if (oldGen && oldGen.isQuiet && oldGen.isValid) {
        await flushQuietGeneration(key);
    }

    const lockTime = new Date();
    let preContinue = 0;
    if (type === "continue") {
        const ctx = getContext();
        const last = ctx.chat[ctx.chat.length - 1];
        if (last) {
            preContinue =
                last.extra?.token_count ??
                (await countTokens(last.mes || "")).count;
        }
    }

    const now = Date.now();
    for (const [k, v] of activeGenerations.entries()) {
        if (now - v.timestamp.getTime() > 600000) {
            activeGenerations.delete(k);
        }
    }

    activeGenerations.set(key, {
        timestamp: lockTime,
        model: getGeneratingModel() || "unknown",
        inTokens: 0,
        preContinueTokens: preContinue,
        estimated: false,
        isValid: false,
        isQuiet: type === "quiet",
    });
}

async function handleGenerateAfterData(data, dryRun) {
    const key = dryRun ? "dryRun" : "main";
    const gen = activeGenerations.get(key);
    if (!gen) return;

    const payload = await calculateInputPayload(data.prompt);
    gen.inTokens = payload.count;
    gen.estimated = payload.estimated;
    gen.isValid = true;
}

async function handleMessageReceived(index, type) {
    const key = "main";
    const gen = activeGenerations.get(key);

    if (["command", "first_message"].includes(type) || !gen?.isValid) return;

    const ctx = getContext();
    const msg = ctx.chat[index];
    if (!msg?.mes) return;

    const apiUsage = parseApiUsage(msg.extra?.api_usage);
    let inTokens = gen.inTokens;
    let outTokens = 0;
    let outEst = false;

    if (apiUsage) {
        inTokens = apiUsage.input;
        outTokens = apiUsage.output;
        outEst = false; // API-reported is exact
    } else {
        outTokens = msg.extra?.token_count;
        if (typeof outTokens !== "number") {
            const res = await countTokens(msg.mes);
            outTokens = res.count;
            outEst = res.estimated;
        }

        if (msg.extra?.reasoning) {
            const rRes = await countTokens(msg.extra.reasoning);
            outTokens += rRes.count;
            if (rRes.estimated) outEst = true;
        }

        if (type === "continue" && gen.preContinueTokens > 0) {
            outTokens = Math.max(0, outTokens - gen.preContinueTokens);
        }
    }

    commitRecord(
        gen.timestamp,
        gen.model,
        inTokens,
        outTokens,
        gen.estimated || outEst,
    );
    activeGenerations.delete(key);
}

async function handleGenerationStopped(isDryRun) {
    const key = isDryRun ? "dryRun" : "main";
    const gen = activeGenerations.get(key);
    if (!gen?.isValid) return;

    if (gen.isQuiet) {
        await flushQuietGeneration(key);
        return;
    }

    let outTokens = 0;
    let outEst = false;

    if (streamingProcessor?.result) {
        const res = await countTokens(streamingProcessor.result);
        outTokens += res.count;
        outEst = res.estimated;
    }
    if (streamingProcessor?.reasoningHandler?.reasoning) {
        const res = await countTokens(
            streamingProcessor.reasoningHandler.reasoning,
        );
        outTokens += res.count;
        if (res.estimated) outEst = true;
    }

    if (gen.preContinueTokens > 0) {
        outTokens = Math.max(0, outTokens - gen.preContinueTokens);
    }

    commitRecord(
        gen.timestamp,
        gen.model,
        gen.inTokens,
        outTokens,
        gen.estimated || outEst,
    );
    activeGenerations.delete(key);
}

async function handleChatChanged() {
    activeGenerations.clear();
}

async function flushQuietGeneration(key) {
    const gen = activeGenerations.get(key);
    if (!gen) return;

    let outTokens = 0;
    let outEst = false;

    if (streamingProcessor?.result) {
        const res = await countTokens(streamingProcessor.result);
        outTokens = res.count;
        outEst = res.estimated;
    }

    if (gen.inTokens > 0 || outTokens > 0) {
        commitRecord(
            gen.timestamp,
            gen.model,
            gen.inTokens,
            outTokens,
            gen.estimated || outEst
        );
    }
    activeGenerations.delete(key);
}

// --- Background Generations Patching ---

function patchBackgroundGenerations() {
    patchConnectionManager();
}

function patchConnectionManager() {
    connectionManagerPatchInterval = setInterval(() => {
        try {
            const context = getContext();
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(connectionManagerPatchInterval);
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest;

            const patchedSendRequest = async function(profileId, messages, maxTokens, custom, overridePayload) {
                if (isTrackingBackground) {
                    return await originalSendRequest.apply(ServiceClass, arguments);
                }

                let inputTokens = 0;
                const modelId = getGeneratingModel() || "unknown";

                try {
                    isTrackingBackground = true;

                    const payload = await calculateInputPayload(messages);
                    inputTokens = payload.count;

                    const result = await originalSendRequest.apply(ServiceClass, arguments);

                    let outputTokens = 0;
                    if (result && typeof result.content === 'string') {
                        const outPayload = await countTokens(result.content);
                        outputTokens = outPayload.count;
                    } else if (typeof result === 'string') {
                        const outPayload = await countTokens(result);
                        outputTokens = outPayload.count;
                    }

                    if (outputTokens > 0 || inputTokens > 0) {
                        commitRecord(new Date(), modelId, inputTokens, outputTokens, false);
                    }

                    return result;
                } catch (e) {
                    console.error('[Token Analytics] Patched sendRequest execution error:', e);
                    return await originalSendRequest.apply(ServiceClass, arguments);
                } finally {
                    isTrackingBackground = false;
                }
            };

            patchedSendRequest._isPatched = true;
            patchedSendRequest._original = originalSendRequest;
            ServiceClass.sendRequest = patchedSendRequest;

            clearInterval(connectionManagerPatchInterval);
        } catch (e) {
            console.error('[Token Analytics] Failed to patch ConnectionManager:', e);
        }
    }, 1000);
}

function unpatchConnectionManager() {
    if (connectionManagerPatchInterval) {
        clearInterval(connectionManagerPatchInterval);
    }
    try {
        const context = getContext();
        const ServiceClass = context?.ConnectionManagerRequestService;
        if (ServiceClass && ServiceClass.sendRequest?._isPatched && ServiceClass.sendRequest?._original) {
            ServiceClass.sendRequest = ServiceClass.sendRequest._original;
            console.log('[Token Analytics] ConnectionManager unpatched gracefully.');
        }
    } catch (e) {
        console.error('[Token Analytics] Error unpatching ConnectionManager:', e);
    }
}

// --- Database Writes ---

function commitRecord(dateObj, modelId, inT, outT, isEst) {
    if (inT === 0 && outT === 0) return;
    if (!isValidModelId(modelId)) return;

    const keys = [
        { type: "hourly", key: formatDateKey(dateObj, "YYYY-MM-DD[T]HH") },
        { type: "daily", key: formatDateKey(dateObj, "YYYY-MM-DD") },
        { type: "monthly", key: formatDateKey(dateObj, "YYYY-MM") },
    ];

    const total = inT + outT;

    keys.forEach(({ type, key }) => {
        db.records[type][key] ??= {
            in: 0,
            out: 0,
            total: 0,
            reqs: 0,
            est: false,
            models: {},
        };
        const node = db.records[type][key];
        node.in += inT;
        node.out += outT;
        node.total += total;
        node.reqs += 1;
        if (isEst) node.est = true;

        node.models[modelId] ??= { in: 0, out: 0, total: 0 };
        node.models[modelId].in += inT;
        node.models[modelId].out += outT;
        node.models[modelId].total += total;
    });

    saveSettingsDebounced();
    eventSource.emit("kuro_ta_updated");
}

// --- Data Aggregation ---

function getModelConfig(mId) {
    if (!isValidModelId(mId)) {
        return { color: "hsl(0, 0%, 50%)", priceIn: 0, priceOut: 0 };
    }
    
    // Exact match lookup
    if (Object.prototype.hasOwnProperty.call(db.models, mId)) {
        return db.models[mId];
    }

    // Normalized fallback lookup (avoids config duplication)
    const normId = getNormalizedModelId(mId);
    for (const key in db.models) {
        if (getNormalizedModelId(key) === normId) {
            return db.models[key];
        }
    }

    const existingCount = Object.keys(db.models).length;
    const hue = Math.floor((existingCount * 137.5) % 360);
    db.models[mId] = {
        color: `hsl(${hue}, 70%, 60%)`,
        priceIn: 0,
        priceOut: 0,
    };
    saveSettingsDebounced();
    return db.models[mId];
}

const calcCost = (inT, outT, mId) => {
    if (!isValidModelId(mId)) return 0;
    const cfg = getModelConfig(mId);
    return (inT / 1000000) * cfg.priceIn + (outT / 1000000) * cfg.priceOut;
};

function buildDataset(view) {
    const result = {
        total: 0,
        in: 0,
        out: 0,
        reqs: 0,
        cost: 0,
        hasEst: false,
        series: [],
        models: {},
    };

    let targetType = "daily";
    let keysToFetch = [];

    if (view === "24H") {
        targetType = "hourly";
        for (let i = 23; i >= 0; i--) {
            const d = new Date(Date.now() - i * 3600000);
            keysToFetch.push({
                key: formatDateKey(d, "YYYY-MM-DD[T]HH"),
                label: formatDateKey(d, "HH:00"),
            });
        }
    } else if (view === "7D" || view === "30D") {
        targetType = "daily";
        const days = view === "7D" ? 7 : 30;
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            keysToFetch.push({
                key: formatDateKey(d, "YYYY-MM-DD"),
                label: formatDateKey(d, "MM/DD"),
            });
        }
    } else if (view === "1Y") {
        targetType = "monthly";
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            keysToFetch.push({
                key: formatDateKey(d, "YYYY-MM"),
                label: formatDateKey(d, "MMM"),
            });
        }
    } else if (view === "ALL") {
        targetType = "monthly";
        const years = new Set();
        Object.keys(db.records.monthly).forEach((k) =>
            years.add(k.substring(0, 4)),
        );
        const sortedYears = Array.from(years).sort();
        if (sortedYears.length === 0)
            sortedYears.push(formatDateKey(new Date(), "YYYY"));
        keysToFetch = sortedYears.map((y) => ({
            key: y,
            label: y,
            isYear: true,
        }));
    }

    keysToFetch.forEach((item) => {
        let node = { in: 0, out: 0, total: 0, reqs: 0, est: false, models: {} };

        if (item.isYear) {
            Object.entries(db.records.monthly).forEach(([mKey, mNode]) => {
                if (mKey.startsWith(item.key)) {
                    node.in += mNode.in;
                    node.out += mNode.out;
                    node.total += mNode.total;
                    node.reqs += mNode.reqs;
                    if (mNode.est) node.est = true;
                    Object.entries(mNode.models).forEach(([mId, mData]) => {
                        if (!isValidModelId(mId)) return;
                        node.models[mId] ??= { in: 0, out: 0, total: 0 };
                        node.models[mId].in += mData.in;
                        node.models[mId].out += mData.out;
                        node.models[mId].total += mData.total;
                    });
                }
            });
        } else {
            node = db.records[targetType][item.key] || node;
        }

        result.in += node.in;
        result.out += node.out;
        result.total += node.total;
        result.reqs += node.reqs;
        if (node.est) result.hasEst = true;

        let nodeCost = 0;
        Object.entries(node.models).forEach(([mId, mData]) => {
            if (!isValidModelId(mId)) return;
            const c = calcCost(mData.in, mData.out, mId);
            nodeCost += c;
            result.cost += c;

            result.models[mId] ??= { in: 0, out: 0, total: 0, cost: 0 };
            result.models[mId].in += mData.in;
            result.models[mId].out += mData.out;
            result.models[mId].total += mData.total;
            result.models[mId].cost += c;
        });

        result.series.push({
            label: item.label,
            fullKey: item.key,
            ...node,
            cost: nodeCost,
        });
    });

    return result;
}

const fmt = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(2) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toString();
};

const fmtFull = (num) => new Intl.NumberFormat("en-US").format(num);

// --- UI Rendering Operations ---

function renderUI() {
    const data = buildDataset(currentView);
    renderMetrics(data);
    renderChart(data.series);
    renderModelsList(data.models, data.total);
}

function renderMetrics(data) {
    let unitLabel = "day";
    let divisor = 1;
    if (currentView === "24H") {
        unitLabel = "hour";
        divisor = 24;
    } else if (currentView === "7D") {
        unitLabel = "day";
        divisor = 7;
    } else if (currentView === "30D") {
        unitLabel = "day";
        divisor = 30;
    } else if (currentView === "1Y") {
        unitLabel = "month";
        divisor = 12;
    } else if (currentView === "ALL") {
        divisor = Math.max(1, data.series.length);
        unitLabel = "year";
    }

    const avgTokens = Math.round(data.total / divisor);
    const avgCost = data.cost / divisor;
    const avgReqs = data.reqs / divisor;

    const avgTokensPerReq =
        data.reqs > 0 ? Math.round(data.total / data.reqs) : 0;
    const avgCostPerReq = data.reqs > 0 ? data.cost / data.reqs : 0;

    const estHtml = data.hasEst
        ? `<span class="kuro-ta-estimated-warn" title="Some tokens were estimated due to tokenizer unavailability">*</span>`
        : "";

    $("#kuro-ta-val-tokens").html(`${fmt(data.total)}${estHtml}`);
    $("#kuro-ta-sub-tokens").html(
        `<span>Avg: ${fmt(avgTokens)}/${unitLabel}</span>`,
    );

    $("#kuro-ta-val-cost").text(`$${data.cost.toFixed(2)}`);
    $("#kuro-ta-sub-cost").html(
        `<span>Avg: $${avgCost.toFixed(3)}/${unitLabel}</span>`,
    );

    $("#kuro-ta-val-reqs").text(fmtFull(data.reqs));
    $("#kuro-ta-sub-reqs").html(
        `<span>Avg: ${avgReqs.toFixed(1)}/${unitLabel}</span>`,
    );

    $("#kuro-ta-val-eff").text(fmt(avgTokensPerReq));
    $("#kuro-ta-sub-eff").html(
        `<span>Cost: $${avgCostPerReq.toFixed(4)}/req</span>`,
    );
}

function renderChart(series) {
    const container = document.getElementById("kuro-ta-chart");
    if (!container) return;
    container.innerHTML = "";

    const rect = container.getBoundingClientRect();
    const w = rect.width || 400;
    const h = 200;

    const pad = { t: 10, r: 10, b: 20, l: 40 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "kuro-ta-chart-svg");
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    const maxVal = Math.max(...series.map((d) => d.total), 100);
    const niceMax = Math.ceil(maxVal / 100) * 100;

    for (let i = 0; i <= 4; i++) {
        const val = (niceMax / 4) * i;
        const y = pad.t + ch - (val / niceMax) * ch;

        const line = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "line",
        );
        line.setAttribute("x1", pad.l);
        line.setAttribute("y1", y);
        line.setAttribute("x2", w - pad.r);
        line.setAttribute("y2", y);
        line.setAttribute("class", "kuro-ta-chart-grid-line");
        svg.appendChild(line);

        const text = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text",
        );
        text.setAttribute("x", pad.l - 6);
        text.setAttribute("y", y + 3);
        text.setAttribute("class", "kuro-ta-chart-grid-text");
        text.textContent = fmt(val);
        svg.appendChild(text);
    }

    const stepX = cw / series.length;
    const barW = Math.min(stepX * 0.8, 24);

    svg.addEventListener("mousemove", (e) => {
        const target = e.target.closest(".kuro-ta-bar-group");
        if (target) {
            const idx = parseInt(target.getAttribute("data-idx"));
            showTooltip(e, series[idx]);
        } else {
            hideTooltip();
        }
    });
    svg.addEventListener("mouseleave", hideTooltip);

    series.forEach((d, i) => {
        const cx = pad.l + i * stepX + stepX / 2;
        const bx = cx - barW / 2;
        const bh = (d.total / niceMax) * ch;
        const by = pad.t + ch - bh;

        const group = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "g",
        );
        group.setAttribute("class", "kuro-ta-bar-group");
        group.setAttribute("data-idx", i);

        const hit = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "rect",
        );
        hit.setAttribute("x", pad.l + i * stepX);
        hit.setAttribute("y", pad.t);
        hit.setAttribute("width", stepX);
        hit.setAttribute("height", ch);
        hit.setAttribute("fill", "var(--SmartThemeBodyColor)");
        hit.setAttribute("class", "kuro-ta-bar-hover");
        group.appendChild(hit);

        if (d.total > 0) {
            let curY = by + bh;
            const sortedModels = Object.entries(d.models).sort(
                (a, b) => b[1].total - a[1].total,
            );

            for (const [mId, mData] of sortedModels) {
                if (!isValidModelId(mId)) continue;
                const sh = (mData.total / d.total) * bh;
                curY -= sh;

                const barRect = document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "rect",
                );
                barRect.setAttribute("x", bx);
                barRect.setAttribute("y", curY);
                barRect.setAttribute("width", barW);
                barRect.setAttribute("height", sh);
                barRect.setAttribute("fill", getModelConfig(mId).color);
                barRect.setAttribute("class", "kuro-ta-chart-bar");
                group.appendChild(barRect);
            }
        }

        const showLabel =
            series.length <= 14 || i % Math.ceil(series.length / 7) === 0;
        if (showLabel) {
            const text = document.createElementNS(
                "http://www.w3.org/2000/svg",
                "text",
            );
            text.setAttribute("x", cx);
            text.setAttribute("y", h - 4);
            text.setAttribute("class", "kuro-ta-chart-label-text");
            text.textContent = d.label;
            group.appendChild(text);
        }

        svg.appendChild(group);
    });

    container.appendChild(svg);
}

function renderModelsList(modelsData, totalTokens) {
    const list = $("#kuro-ta-models-list");
    list.empty();

    const sorted = Object.entries(modelsData).sort(
        (a, b) => b[1].total - a[1].total,
    );

    if (sorted.length === 0) {
        list.append(
            '<div class="kuro-ta-empty-msg">No models recorded in this timeframe.</div>',
        );
        return;
    }

    for (const [mId, data] of sorted) {
        if (!isValidModelId(mId)) continue;
        const cfg = getModelConfig(mId);
        const pct =
            totalTokens > 0 ? ((data.total / totalTokens) * 100).toFixed(1) : 0;
        const safeMId = escapeHtml(mId);
        const safeColor = escapeHtml(cfg.color);
        const safePriceIn = cfg.priceIn || "";
        const safePriceOut = cfg.priceOut || "";

        const row = $(`
            <div class="kuro-ta-model-row">
                <input type="color" class="kuro-ta-color-picker" value="${safeColor}" data-id="${safeMId}">
                <div class="kuro-ta-model-name" title="${safeMId}">${safeMId}</div>
                <div class="kuro-ta-model-stats">
                    ${fmt(data.total)} <span class="kuro-ta-model-pct">(${pct}%)</span><br>
                    <span>$${data.cost.toFixed(3)}</span>
                </div>
                <div class="kuro-ta-price-inputs">
                    <input type="number" class="kuro-ta-price-input" data-id="${safeMId}" data-type="priceIn" value="${safePriceIn}" placeholder="In/1M" step="0.01">
                    <input type="number" class="kuro-ta-price-input" data-id="${safeMId}" data-type="priceOut" value="${safePriceOut}" placeholder="Out/1M" step="0.01">
                </div>
            </div>
        `);
        list.append(row);
    }

    list.find(".kuro-ta-color-picker").on("change", function () {
        const mId = $(this).data("id");
        if (!isValidModelId(mId)) return;
        db.models[mId].color = $(this).val();
        saveSettingsDebounced();
        renderUI();
    });

    let debounce;
    list.find(".kuro-ta-price-input").on("input", function () {
        clearTimeout(debounce);
        const el = $(this);
        debounce = setTimeout(() => {
            const mId = el.data("id");
            const type = el.data("type");
            if (!isValidModelId(mId)) return;
            db.models[mId][type] = parseFloat(el.val()) || 0;
            saveSettingsDebounced();
            renderUI();
        }, 400);
    });
}

// --- Tooltip Operations ---

function showTooltip(e, d) {
    if (!tooltipEl) return;

    let modelsHtml = "";
    const sorted = Object.entries(d.models).sort(
        (a, b) => b[1].total - a[1].total,
    );
    for (const [mId, mData] of sorted) {
        if (!isValidModelId(mId)) continue;
        modelsHtml += `
            <div class="kuro-ta-tt-model">
                <div class="kuro-ta-tt-model-meta">
                    <span class="kuro-ta-tt-dot" style="background: ${escapeHtml(getModelConfig(mId).color)}"></span>
                    ${escapeHtml(mId)}
                </div>
                <span> ${fmtFull(mData.total)}</span>
            </div>
        `;
    }

    tooltipEl.innerHTML = `
        <div class="kuro-ta-tt-header">${escapeHtml(d.label)} <span style="opacity:0.5; font-weight:normal;">(${escapeHtml(d.fullKey)})</span></div>
        <div class="kuro-ta-tt-row"><span>Total</span><span>${fmtFull(d.total)}</span></div>
        <div class="kuro-ta-tt-row"><span>Input</span><span>${fmtFull(d.in)}</span></div>
        <div class="kuro-ta-tt-row"><span>Output</span><span>${fmtFull(d.out)}</span></div>
        <div class="kuro-ta-tt-row"><span>Requests</span><span>${fmtFull(d.reqs)}</span></div>
        <div class="kuro-ta-tt-row"><span>Cost</span><span>$${d.cost.toFixed(4)}</span></div>
        ${d.est ? '<div class="kuro-ta-tt-est-warn">* Contains estimated tokens</div>' : ""}
        ${modelsHtml ? `<div class="kuro-ta-tt-models">${modelsHtml}</div>` : ""}
    `;
    tooltipEl.style.display = "block";

    let x = e.clientX + 15;
    let y = e.clientY + 15;
    const rect = tooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - 15;
    if (y + rect.height > window.innerHeight)
        y = window.innerHeight - rect.height - 15;
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
}

const hideTooltip = () => {
    if (tooltipEl) tooltipEl.style.display = "none";
};

// --- Initialization & UI Construction ---

function injectUI() {
    // Prevent duplicated DOM and observers upon reloading the script
    $(".kuro-ta-container").closest(".inline-drawer").remove();
    $("#kuro-ta-tooltip").remove();
    if (globalResizeObserver) {
        globalResizeObserver.disconnect();
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Token Usage and Cost Statistics</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <div class="kuro-ta-container">
                
                <div class="kuro-ta-controls">
                    <div class="menu_button menu_button_active kuro-ta-tf-btn" data-view="24H">24H</div>
                    <div class="menu_button kuro-ta-tf-btn" data-view="7D">7D</div>
                    <div class="menu_button kuro-ta-tf-btn" data-view="30D">30D</div>
                    <div class="menu_button kuro-ta-tf-btn" data-view="1Y">1Y</div>
                    <div class="menu_button kuro-ta-tf-btn" data-view="ALL">ALL</div>
                </div>

                <div class="kuro-ta-metrics">
                    <div class="kuro-ta-metric-card">
                        <div class="kuro-ta-metric-label">Tokens</div>
                        <div class="kuro-ta-metric-value" id="kuro-ta-val-tokens">0</div>
                        <div class="kuro-ta-metric-sub" id="kuro-ta-sub-tokens"><span>Avg: 0/day</span></div>
                    </div>
                    <div class="kuro-ta-metric-card">
                        <div class="kuro-ta-metric-label">Cost</div>
                        <div class="kuro-ta-metric-value" id="kuro-ta-val-cost">$0.00</div>
                        <div class="kuro-ta-metric-sub" id="kuro-ta-sub-cost"><span>Avg: $0.00/day</span></div>
                    </div>
                    <div class="kuro-ta-metric-card">
                        <div class="kuro-ta-metric-label">Requests</div>
                        <div class="kuro-ta-metric-value" id="kuro-ta-val-reqs">0</div>
                        <div class="kuro-ta-metric-sub" id="kuro-ta-sub-reqs"><span>Avg: 0/day</span></div>
                    </div>
                    <div class="kuro-ta-metric-card">
                        <div class="kuro-ta-metric-label">Efficiency</div>
                        <div class="kuro-ta-metric-value" id="kuro-ta-val-eff">0</div>
                        <div class="kuro-ta-metric-sub" id="kuro-ta-sub-eff"><span>Avg: $0.00/req</span></div>
                    </div>
                </div>

                <div class="kuro-ta-chart-wrapper" id="kuro-ta-chart"></div>

                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header kuro-ta-sub-drawer-header">
                        <b>Models, Tokens & Pricing</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="kuro-ta-models-list" id="kuro-ta-models-list"></div>
                    </div>
                </div>

                <div class="kuro-ta-utils">
                    <div class="menu_button" id="kuro-ta-export" title="Export Data"><i class="fa-solid fa-file-export"></i>   Export</div>
                    <div class="menu_button" id="kuro-ta-import" title="Import Data"><i class="fa-solid fa-file-import"></i> Import</div>
                    <div class="menu_button kuro-ta-btn-danger" id="kuro-ta-reset" title="Reset Data"><i class="fa-solid fa-trash"></i> Reset</div>
                    <input type="file" id="kuro-ta-file" class="kuro-ta-hidden" accept=".json">
                </div>

            </div>
        </div>
    `;

    const target = $("#extensions_settings2").length
        ? $("#extensions_settings2")
        : $("#extensions_settings");
    target.append(html);

    tooltipEl = document.createElement("div");
    tooltipEl.id = "kuro-ta-tooltip";
    document.body.appendChild(tooltipEl);

    $(".kuro-ta-tf-btn").on("click", function () {
        $(".kuro-ta-tf-btn").removeClass("menu_button_active");
        $(this).addClass("menu_button_active");
        currentView = $(this).data("view");
        renderUI();
    });

    $("#kuro-ta-export").on("click", () => {
        const blob = new Blob([JSON.stringify(db, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "kuro_token_analytics_backup.json";
        a.click();
        URL.revokeObjectURL(url);
    });

    $("#kuro-ta-reset").on("click", () => {
        if (
            confirm(
                "Are you sure you want to delete all token analytics data? This cannot be undone.",
            )
        ) {
            db.records = { hourly: {}, daily: {}, monthly: {} };
            db.models = {};
            saveSettingsDebounced();
            renderUI();
        }
    });

    $("#kuro-ta-import").on("click", () => $("#kuro-ta-file").click());
    $("#kuro-ta-file").on("change", function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target.result);
                if (parsed.records && parsed.models) {
                    db.records = parsed.records;
                    db.models = {};

                    // Defensive validation on import keys
                    Object.entries(parsed.models).forEach(([mId, config]) => {
                        if (isValidModelId(mId)) {
                            db.models[mId] = config;
                        }
                    });

                    saveSettingsDebounced();
                    renderUI();
                    toastr.success("Data imported successfully.");
                } else {
                    toastr.error("Invalid backup file format.");
                }
            } catch (err) {
                toastr.error("Failed to parse JSON.");
            }
        };
        reader.readAsText(file);
        $(this).val("");
    });

    globalResizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeDebounceTimeout);
        resizeDebounceTimeout = setTimeout(() => {
            const data = buildDataset(currentView);
            renderChart(data.series);
        }, 100);
    });
    globalResizeObserver.observe(document.getElementById("kuro-ta-chart"));
}

// --- Initialization / Bootstrap ---

const handleUpdate = () => renderUI();

async function init() {
    initDB();
    
    // Register background patching hooks
    patchBackgroundGenerations();

    // Register ST event listeners
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on("kuro_ta_updated", handleUpdate);

    // Defensively clean up global listener states on reload/hot-reload
    if (typeof window.kuroTokenAnalyticsCleanup === "function") {
        window.kuroTokenAnalyticsCleanup();
    }

    window.kuroTokenAnalyticsCleanup = () => {
        eventSource.removeListener(event_types.GENERATION_STARTED, handleGenerationStarted);
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, handleMessageReceived);
        eventSource.removeListener(event_types.GENERATION_STOPPED, handleGenerationStopped);
        eventSource.removeListener(event_types.CHAT_CHANGED, handleChatChanged);
        eventSource.removeListener("kuro_ta_updated", handleUpdate);
        globalResizeObserver?.disconnect();
        unpatchConnectionManager();
    };

    // Safely load UI elements when browser or webview interface is ready
    if (document.getElementById("extensions_settings") || document.getElementById("extensions_settings2")) {
        injectUI();
        renderUI();
    } else {
        eventSource.on(event_types.APP_READY, () => {
            injectUI();
            renderUI();
        });
    }
}

// Self-initialize for third-party loading environments (where manifest hooks do not fire)
jQuery(async () => {
    await init();
});

// Exported standard lifecycle hook for native/built-in environments
export async function onActivate() {
    await init();
}