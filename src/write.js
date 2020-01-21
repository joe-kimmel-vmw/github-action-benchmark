"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path = __importStar(require("path"));
const io = __importStar(require("@actions/io"));
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const Octokit = require("@octokit/rest");
const git = __importStar(require("./git"));
const default_index_html_1 = require("./default_index_html");
exports.SCRIPT_PREFIX = 'window.BENCHMARK_DATA = ';
const DEFAULT_DATA_JSON = {
    lastUpdate: 0,
    repoUrl: '',
    entries: {},
};
async function loadDataJs(dataPath) {
    try {
        const script = await fs_1.promises.readFile(dataPath, 'utf8');
        const json = script.slice(exports.SCRIPT_PREFIX.length);
        const parsed = JSON.parse(json);
        core.debug(`Loaded data.js at ${dataPath}`);
        return parsed;
    }
    catch (err) {
        console.log(`Could not find data.js at ${dataPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}
async function storeDataJs(dataPath, data) {
    const script = exports.SCRIPT_PREFIX + JSON.stringify(data, null, 2);
    await fs_1.promises.writeFile(dataPath, script, 'utf8');
    core.debug(`Overwrote ${dataPath} for adding new data`);
}
async function addIndexHtmlIfNeeded(dir) {
    const indexHtml = path.join(dir, 'index.html');
    try {
        await fs_1.promises.stat(indexHtml);
        core.debug(`Skipped to create default index.html since it is already existing: ${indexHtml}`);
        return;
    }
    catch (_) {
        // Continue
    }
    await fs_1.promises.writeFile(indexHtml, default_index_html_1.DEFAULT_INDEX_HTML, 'utf8');
    await git.cmd('add', indexHtml);
    console.log('Created default index.html at', indexHtml);
}
function biggerIsBetter(tool) {
    switch (tool) {
        case 'cargo':
            return false;
        case 'go':
            return false;
        case 'benchmarkjs':
            return true;
        case 'pytest':
            return true;
        case 'googlecpp':
            return false;
        case 'catch2':
            return false;
    }
}
function findAlerts(curSuite, prevSuite, threshold) {
    core.debug(`Comparing current:${curSuite.commit.id} and prev:${prevSuite.commit.id} for alert`);
    const alerts = [];
    for (const current of curSuite.benches) {
        const prev = prevSuite.benches.find(b => b.name === current.name);
        if (prev === undefined) {
            core.debug(`Skipped because benchmark '${current.name}' is not found in previous benchmarks`);
            continue;
        }
        const ratio = biggerIsBetter(curSuite.tool)
            ? prev.value / current.value // e.g. current=100, prev=200
            : current.value / prev.value; // e.g. current=200, prev=100
        if (ratio > threshold) {
            core.warning(`Performance alert! Previous value was ${prev.value} and current value is ${current.value}.` +
                ` It is ${ratio}x worse than previous exceeding a ratio threshold ${threshold}`);
            alerts.push({ current, prev, ratio });
        }
    }
    return alerts;
}
function getCurrentRepo() {
    const repo = github.context.payload.repository;
    if (!repo) {
        throw new Error(`Repository information is not available in payload: ${JSON.stringify(github.context.payload, null, 2)}`);
    }
    return repo;
}
function floatStr(n) {
    return Number.isInteger(n) ? n.toFixed(1) : n.toString();
}
function buildAlertComment(alerts, benchName, curSuite, prevSuite, threshold, cc) {
    var _a;
    function strVal(b) {
        let s = `\`${b.value}\` ${b.unit}`;
        if (b.range) {
            s += ` (\`${b.range}\`)`;
        }
        return s;
    }
    // Do not show benchmark name if it is the default value 'Benchmark'.
    const benchmarkText = benchName === 'Benchmark' ? '' : ` **'${benchName}'**`;
    const title = threshold === 0 ? '# Performance Report' : '# :warning: **Performance Alert** :warning:';
    const thresholdString = floatStr(threshold);
    const lines = [
        title,
        '',
        `Possible performance regression was detected for benchmark${benchmarkText}.`,
        `Benchmark result of this commit is worse than the previous benchmark result exceeding threshold \`${thresholdString}\`.`,
        '',
        `| Benchmark suite | Current: ${curSuite.commit.id} | Previous: ${prevSuite.commit.id} | Ratio |`,
        '|-|-|-|-|',
    ];
    for (const alert of alerts) {
        const { current, prev, ratio } = alert;
        const line = `| \`${current.name}\` | ${strVal(current)} | ${strVal(prev)} | \`${floatStr(ratio)}\` |`;
        lines.push(line);
    }
    const repo = getCurrentRepo();
    // eslint-disable-next-line @typescript-eslint/camelcase
    const repoUrl = (_a = repo.html_url, (_a !== null && _a !== void 0 ? _a : ''));
    const actionUrl = repoUrl + '/actions?query=workflow%3A' + encodeURIComponent(github.context.workflow);
    core.debug(`Action URL: ${actionUrl}`);
    // Footer
    lines.push('', `This comment was automatically generated by [workflow](${actionUrl}) using [github-action-benchmark](https://github.com/marketplace/actions/continuous-benchmark).`);
    if (cc.length > 0) {
        lines.push('', `CC: ${cc.join(' ')}`);
    }
    return lines.join('\n');
}
async function leaveComment(commitId, body, token) {
    var _a;
    core.debug('Sending alert comment:\n' + body);
    const repo = getCurrentRepo();
    // eslint-disable-next-line @typescript-eslint/camelcase
    const repoUrl = (_a = repo.html_url, (_a !== null && _a !== void 0 ? _a : ''));
    const client = new Octokit({ auth: token });
    const res = await client.repos.createCommitComment({
        owner: repo.owner.login,
        repo: repo.name,
        // eslint-disable-next-line @typescript-eslint/camelcase
        commit_sha: commitId,
        body,
    });
    const commitUrl = `${repoUrl}/commit/${commitId}`;
    console.log(`Alert comment was sent to ${commitUrl}. Response:`, res.status, res.data);
    return res;
}
async function handleAlert(benchName, curSuite, prevSuite, config) {
    const { alertThreshold, githubToken, commentOnAlert, failOnAlert, alertCommentCcUsers, failThreshold } = config;
    if (!commentOnAlert && !failOnAlert) {
        core.debug('Alert check was skipped because both comment-on-alert and fail-on-alert were disabled');
        return;
    }
    const alerts = findAlerts(curSuite, prevSuite, alertThreshold);
    if (alerts.length === 0) {
        core.debug('No performance alert found happily');
        return;
    }
    core.debug(`Found ${alerts.length} alerts`);
    const body = buildAlertComment(alerts, benchName, curSuite, prevSuite, alertThreshold, alertCommentCcUsers);
    let message = body;
    let url = null;
    if (commentOnAlert) {
        if (!githubToken) {
            throw new Error("'comment-on-alert' input is set but 'github-token' input is not set");
        }
        const res = await leaveComment(curSuite.commit.id, body, githubToken);
        // eslint-disable-next-line @typescript-eslint/camelcase
        url = res.data.html_url;
        message = body + `\nComment was generated at ${url}`;
    }
    if (failOnAlert) {
        // Note: alertThreshold is smaller than failThreshold. It was checked in config.ts
        const len = alerts.length;
        const threshold = floatStr(failThreshold);
        const failures = alerts.filter(a => a.ratio > failThreshold);
        if (failures.length > 0) {
            core.debug('Mark this workflow as fail since one or more fatal alerts found');
            if (failThreshold !== alertThreshold) {
                // Prepend message that explains how these alerts were detected with different thresholds
                message = `${failures.length} of ${len} alerts exceeded the failure threshold \`${threshold}\` specified by fail-threshold input:\n\n${message}`;
            }
            throw new Error(message);
        }
        else {
            core.debug(`${len} alerts exceeding the alert threshold ${alertThreshold} were found but` +
                ` all of them did not exceed the failure threshold ${threshold}`);
        }
    }
}
function addBenchmarkToDataJson(benchName, bench, data, maxItems) {
    var _a, _b;
    // eslint-disable-next-line @typescript-eslint/camelcase
    const htmlUrl = (_b = (_a = github.context.payload.repository) === null || _a === void 0 ? void 0 : _a.html_url, (_b !== null && _b !== void 0 ? _b : ''));
    let prevBench = null;
    data.lastUpdate = Date.now();
    data.repoUrl = htmlUrl;
    // Add benchmark result
    if (data.entries[benchName] === undefined) {
        data.entries[benchName] = [bench];
        core.debug(`No suite was found for benchmark '${benchName}' in existing data. Created`);
    }
    else {
        const suites = data.entries[benchName];
        // Get last suite which has different commit ID for alert comment
        for (const e of suites.slice().reverse()) {
            if (e.commit.id !== bench.commit.id) {
                prevBench = e;
                break;
            }
        }
        suites.push(bench);
        if (maxItems !== null && suites.length > maxItems) {
            suites.splice(0, suites.length - maxItems);
            core.debug(`Number of data items for '${benchName}' was truncated to ${maxItems} due to max-items-in-charts`);
        }
    }
    return prevBench;
}
function isRemoteRejectedError(err) {
    if (err instanceof Error) {
        return ['[remote rejected]', '[rejected]'].some(l => err.message.includes(l));
    }
    return false;
}
async function writeBenchmarkToGitHubPagesWithRetry(bench, config, retry) {
    var _a, _b;
    const { name, tool, ghPagesBranch, benchmarkDataDirPath, githubToken, autoPush, skipFetchGhPages, maxItemsInChart, } = config;
    const dataPath = path.join(benchmarkDataDirPath, 'data.js');
    const isPrivateRepo = (_b = (_a = github.context.payload.repository) === null || _a === void 0 ? void 0 : _a.private, (_b !== null && _b !== void 0 ? _b : false));
    if (!skipFetchGhPages && (!isPrivateRepo || githubToken)) {
        await git.pull(githubToken, ghPagesBranch);
    }
    else if (isPrivateRepo && !skipFetchGhPages) {
        core.warning("'git pull' was skipped. If you want to ensure GitHub Pages branch is up-to-date " +
            "before generating a commit, please set 'github-token' input to pull GitHub pages branch");
    }
    await io.mkdirP(benchmarkDataDirPath);
    const data = await loadDataJs(dataPath);
    const prevBench = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);
    await storeDataJs(dataPath, data);
    await git.cmd('add', dataPath);
    await addIndexHtmlIfNeeded(benchmarkDataDirPath);
    await git.cmd('commit', '-m', `add ${name} (${tool}) benchmark result for ${bench.commit.id}`);
    if (githubToken && autoPush) {
        try {
            await git.push(githubToken, ghPagesBranch);
            console.log(`Automatically pushed the generated commit to ${ghPagesBranch} branch since 'auto-push' is set to true`);
        }
        catch (err) {
            if (!isRemoteRejectedError(err)) {
                throw err;
            }
            // Fall through
            core.warning(`Auto-push failed because the remote ${ghPagesBranch} was updated after git pull`);
            if (retry > 0) {
                core.debug('Rollback the auto-generated commit before retry');
                await git.cmd('reset', '--hard', 'HEAD~1');
                core.warning(`Retrying to generate a commit and push to remote ${ghPagesBranch} with retry count ${retry}...`);
                return await writeBenchmarkToGitHubPagesWithRetry(bench, config, retry - 1); // Recursively retry
            }
            else {
                core.warning(`Failed to add benchmark data to '${name}' data: ${JSON.stringify(bench)}`);
                throw new Error(`Auto-push failed 3 times since the remote branch ${ghPagesBranch} rejected pushing all the time. Last exception was: ${err.message}`);
            }
        }
    }
    else {
        core.debug(`Auto-push to ${ghPagesBranch} is skipped because it requires both 'github-token' and 'auto-push' inputs`);
    }
    return prevBench;
}
async function writeBenchmarkToGitHubPages(bench, config) {
    const { ghPagesBranch, skipFetchGhPages } = config;
    if (!skipFetchGhPages) {
        await git.cmd('fetch', 'origin', `${ghPagesBranch}:${ghPagesBranch}`);
    }
    await git.cmd('switch', ghPagesBranch);
    try {
        return await writeBenchmarkToGitHubPagesWithRetry(bench, config, 10);
    }
    finally {
        // `git switch` does not work for backing to detached head
        await git.cmd('checkout', '-');
    }
}
async function loadDataJson(jsonPath) {
    try {
        const content = await fs_1.promises.readFile(jsonPath, 'utf8');
        const json = JSON.parse(content);
        core.debug(`Loaded external JSON file at ${jsonPath}`);
        return json;
    }
    catch (err) {
        core.warning(`Could not find external JSON file for benchmark data at ${jsonPath}. Using empty default: ${err}`);
        return { ...DEFAULT_DATA_JSON };
    }
}
async function writeBenchmarkToExternalJson(bench, jsonFilePath, config) {
    const { name, maxItemsInChart } = config;
    const data = await loadDataJson(jsonFilePath);
    const prevBench = addBenchmarkToDataJson(name, bench, data, maxItemsInChart);
    try {
        const jsonDirPath = path.dirname(jsonFilePath);
        await io.mkdirP(jsonDirPath);
        await fs_1.promises.writeFile(jsonFilePath, JSON.stringify(data, null, 2), 'utf8');
    }
    catch (err) {
        throw new Error(`Could not store benchmark data as JSON at ${jsonFilePath}: ${err}`);
    }
    return prevBench;
}
async function writeBenchmark(bench, config) {
    const { name, externalDataJsonPath } = config;
    const prevBench = externalDataJsonPath
        ? await writeBenchmarkToExternalJson(bench, externalDataJsonPath, config)
        : await writeBenchmarkToGitHubPages(bench, config);
    // Put this after `git push` for reducing possibility to get conflict on push. Since sending
    // comment take time due to API call, do it after updating remote branch.
    if (prevBench === null) {
        core.debug('Alert check was skipped because previous benchmark result was not found');
    }
    else {
        await handleAlert(name, bench, prevBench, config);
    }
}
exports.writeBenchmark = writeBenchmark;
//# sourceMappingURL=write.js.map