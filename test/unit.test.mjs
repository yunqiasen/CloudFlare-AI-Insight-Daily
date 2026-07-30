import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { buildOpenAIChatUrl, callChatAPI, callChatAPIStream } from '../src/chatapi.js';
import { escapeHtml } from '../src/helpers.js';

class MemoryKV {
    data = new Map();

    async put(key, value) {
        this.data.set(key, value);
    }

    async get(key) {
        return this.data.get(key) ?? null;
    }

    async delete(key) {
        this.data.delete(key);
    }
}

function env() {
    return {
        DATA_KV: new MemoryKV(),
        OPEN_TRANSLATE: 'false',
        USE_MODEL_PLATFORM: 'OPEN',
        OPENAI_API_KEY: 'test-key',
        OPENAI_API_URL: 'https://openrouter.ai/api/v1',
        DEFAULT_OPEN_MODEL: 'test-model',
        GITHUB_TOKEN: 'test-github-token',
        GITHUB_REPO_OWNER: 'owner',
        GITHUB_REPO_NAME: 'repo',
        GITHUB_BRANCH: 'main',
        LOGIN_USERNAME: 'root',
        LOGIN_PASSWORD: 'pw',
        PODCAST_TITLE: 'Podcast',
        PODCAST_BEGIN: 'Begin',
        PODCAST_END: 'End',
        FOLO_COOKIE_KV_KEY: 'folo_auth_cookie',
        FOLO_DATA_API: 'https://example.test/folo',
        FOLO_FILTER_DAYS: '1',
        NEWS_AGGREGATOR_LIST_ID: 'news-list',
        NEWS_AGGREGATOR_FETCH_PAGES: '1',
        HGPAPERS_LIST_ID: 'paper-list',
        HGPAPERS_FETCH_PAGES: '1',
        TWITTER_LIST_ID: 'twitter-list',
        TWITTER_FETCH_PAGES: '1',
        REDDIT_LIST_ID: 'reddit-list',
        REDDIT_FETCH_PAGES: '1',
        DAILY_TITLE: 'AI Daily',
        DAILY_TITLE_MIN: 'AI',
        BOOK_LINK: '',
        INSERT_FOOT: 'false',
        INSERT_AD: 'false',
        INSERT_APP_URL: '',
    };
}

async function login(e) {
    const response = await worker.fetch(new Request('https://example.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=pw&redirect=%2FgetContentHtml',
    }), e);
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
}

function sseResponse(content) {
    return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
    );
}

test('OpenAI Base URL 不重复追加 /v1', () => {
    assert.equal(buildOpenAIChatUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(buildOpenAIChatUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
});

test('HTML 特殊字符会正确转义', () => {
    assert.equal(escapeHtml('<tag a="x">Tom & Jerry\'s</tag>'), '&lt;tag a=&quot;x&quot;&gt;Tom &amp; Jerry&#039;s&lt;/tag&gt;');
});

test('OpenAI 429 有限重试并按标准格式解析', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let captured;
    globalThis.fetch = async (url, options) => {
        calls++;
        captured = { url, body: JSON.parse(options.body), headers: options.headers };
        if (calls < 3) return new Response('{"error":{"message":"limited"}}', { status: 429, headers: { 'retry-after': '0' } });
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
    };
    try {
        const result = await callChatAPI(env(), 'hello', 'system');
        assert.equal(result, 'ok');
        assert.equal(calls, 3);
        assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(captured.body.model, 'test-model');
        assert.equal(captured.headers.Authorization, 'Bearer test-key');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouter 200 响应内的上游错误也会重试', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        if (calls === 1) {
            return Response.json({
                error: { code: 502, message: 'provider at capacity', metadata: { retry_after_seconds: 0 } },
            });
        }
        return Response.json({ choices: [{ message: { content: 'recovered' } }] });
    };
    try {
        const result = await callChatAPI(env(), 'hello');
        assert.equal(result, 'recovered');
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenAI SSE 流式内容可拼接', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
        ': OPENROUTER PROCESSING\n\n' +
        'data: {"choices":[{"delta":{"content":"AI "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n' +
        'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
    );
    try {
        const chunks = [];
        for await (const chunk of callChatAPIStream(env(), 'hello')) chunks.push(chunk);
        assert.equal(chunks.join(''), 'AI OK');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Worker 公开接口、登录会话和受保护接口', async () => {
    const e = env();

    let response = await worker.fetch(new Request('https://example.test/login'), e);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Login/);

    response = await worker.fetch(new Request('https://example.test/getContent?date=2026-07-30'), e);
    assert.equal(response.status, 200);
    const content = await response.json();
    assert.equal(content.date, '2026-07-30');
    assert.deepEqual(content.project, []);

    response = await worker.fetch(new Request('https://example.test/getContentHtml'), e);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /\/login\?redirect=/);

    response = await worker.fetch(new Request('https://example.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=wrong&redirect=%2FgetContentHtml',
    }), e);
    assert.equal(response.status, 401);

    response = await worker.fetch(new Request('https://example.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=root&password=pw&redirect=%2FgetContentHtml',
    }), e);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];

    response = await worker.fetch(new Request('https://example.test/getContentHtml?date=2026-07-30', {
        headers: { cookie },
    }), e);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);

    response = await worker.fetch(new Request('https://example.test/logout', { headers: { cookie } }), e);
    assert.equal(response.status, 302);
});

test('边界请求返回明确状态码', async () => {
    const e = env();
    let response = await worker.fetch(new Request('https://example.test/generateRssContent'), e);
    assert.equal(response.status, 400);

    response = await worker.fetch(new Request('https://example.test/writeRssData'), e);
    assert.equal(response.status, 400);

    response = await worker.fetch(new Request('https://example.test/rss?days=1'), e);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /沒有找到相關資料/);

    response = await worker.fetch(new Request('https://example.test/missing'), e);
    assert.equal(response.status, 302);
});

test('项目采集成功，Folo 缺 Cookie 或上游失败不再假报成功', async () => {
    const e = env();
    const cookie = await login(e);
    const originalFetch = globalThis.fetch;
    const originalRandom = Math.random;
    let foloOk = true;
    Math.random = () => 0;
    globalThis.fetch = async (url) => {
        if (String(url).includes('/github/trending/')) {
            return Response.json({
                version: 'https://jsonfeed.org/version/1.1',
                items: [{
                    id: 'https://github.com/acme/demo',
                    url: 'https://github.com/acme/demo',
                    title: 'acme/demo',
                    content_text: 'Demo project\nLanguage: JavaScript\nStars: 42\nForks: 3',
                    authors: [{ name: 'acme' }],
                }],
            });
        }
        if (String(url) === e.FOLO_DATA_API) {
            if (foloOk) {
                return Response.json({ data: [{
                    entries: {
                        id: 'folo-entry',
                        url: 'https://example.test/entry',
                        title: 'Folo entry',
                        content: '<p>Folo content</p>',
                        publishedAt: new Date().toISOString(),
                        author: 'tester',
                    },
                    feeds: { title: 'Test Feed' },
                }] });
            }
            return Response.json({ message: 'invalid cookie' }, { status: 422, statusText: 'Unprocessable Entity' });
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };
    try {
        e.PROJECTS_API_URL = 'https://rss.example.test/github/trending/daily/any?format=json';
        let response = await worker.fetch(new Request('https://example.test/writeData', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ category: 'project' }),
        }), e);
        assert.equal(response.status, 200);
        let projectResult = await response.json();
        assert.equal(projectResult.projectItemCount, 1);
        assert.equal(projectResult.projectChineseDescriptionCount, 0);

        const existing = JSON.parse(await e.DATA_KV.get('2026-07-30-project'));
        existing[0].description = '已缓存的中文描述';
        await e.DATA_KV.put('2026-07-30-project', JSON.stringify(existing));
        response = await worker.fetch(new Request('https://example.test/writeData', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ category: 'project' }),
        }), e);
        projectResult = await response.json();
        assert.equal(projectResult.projectChineseDescriptionCount, 1);
        assert.equal(JSON.parse(await e.DATA_KV.get('2026-07-30-project'))[0].description, '已缓存的中文描述');

        response = await worker.fetch(new Request('https://example.test/writeData', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ category: 'news' }),
        }), e);
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /Folo Cookie/);

        for (const [category, countField, expectedCount] of [
            ['news', 'newsItemCount', 1],
            ['paper', 'paperItemCount', 1],
            ['socialMedia', 'socialMediaItemCount', 2],
        ]) {
            response = await worker.fetch(new Request('https://example.test/writeData', {
                method: 'POST',
                headers: { cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ category, foloCookie: 'valid' }),
            }), e);
            assert.equal(response.status, 200);
            assert.equal((await response.json())[countField], expectedCount);
        }

        foloOk = false;
        response = await worker.fetch(new Request('https://example.test/writeData', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ category: 'news', foloCookie: 'invalid' }),
        }), e);
        assert.equal(response.status, 502);
        const failed = await response.json();
        assert.equal(failed.success, false);
        assert.deepEqual(failed.storedCategories, []);
        assert.match(failed.errors[0], /Folo News API 422/);
        assert.equal(JSON.parse(await e.DATA_KV.get('2026-07-30-news'))[0].id, 'folo-entry');

        response = await worker.fetch(new Request('https://example.test/writeData', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ category: 'unknown' }),
        }), e);
        assert.equal(response.status, 400);
    } finally {
        globalThis.fetch = originalFetch;
        Math.random = originalRandom;
    }
});

test('AI 日报、播客和分析路由完整生成', async () => {
    const e = env();
    const cookie = await login(e);
    await e.DATA_KV.put('2026-07-30-project', JSON.stringify([{
        id: 1,
        type: 'project',
        title: 'demo',
        url: 'https://github.com/acme/demo',
        description: 'demo project',
        published_date: '2026-07-30',
        details: { totalStars: '42' },
    }]));

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
        assert.match(String(url), /chat\/completions$/);
        calls++;
        return sseResponse(calls % 2 ? '## AI 生成内容\n\n正文' : '今日摘要');
    };
    try {
        let response = await worker.fetch(new Request('https://example.test/genAIContent', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'date=2026-07-30&selectedItems=project%3A1',
        }), e);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /AI日报/);

        response = await worker.fetch(new Request('https://example.test/genAIPodcastScript', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'date=2026-07-30&summarizedContent=' + encodeURIComponent('日报摘要内容'),
        }), e);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /AI播客脚本/);

        response = await worker.fetch(new Request('https://example.test/genAIDailyAnalysis', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ date: '2026-07-30', summarizedContent: '日报摘要内容' }),
        }), e);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /AI 生成内容|今日摘要/);
        assert.equal(calls, 5);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GitHub 提交、RSS 生成、KV 写入和 RSS 输出全链路', async () => {
    const e = env();
    const cookie = await login(e);
    const originalFetch = globalThis.fetch;
    const files = new Map();
    const decodePath = (url) => decodeURIComponent(new URL(url).pathname.split('/contents/')[1] || '');

    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/chat/completions')) {
            return Response.json({ choices: [{ message: { content: 'RSS AI 摘要' } }] });
        }
        if (target.startsWith('https://api.github.com/')) {
            const path = decodePath(target);
            if ((options.method || 'GET') === 'PUT') {
                const body = JSON.parse(options.body);
                files.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
                return Response.json({ content: { path, sha: `sha-${files.size}` } }, { status: 201 });
            }
            if (!files.has(path)) return Response.json({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
            return Response.json({
                sha: `sha-${files.size}`,
                content: Buffer.from(files.get(path), 'utf8').toString('base64'),
            });
        }
        throw new Error(`Unexpected fetch: ${target}`);
    };

    try {
        const daily = '# 日报\n\n### 今日摘要\n摘要\n\n### 重点内容\n测试正文';
        let response = await worker.fetch(new Request('https://example.test/commitToGitHub', {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'date=2026-07-30&daily_summary_markdown=' + encodeURIComponent(daily),
        }), e);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).results[0].status, 'Success');
        assert.equal(files.get('daily/2026-07-30.md'), daily);

        response = await worker.fetch(new Request('https://example.test/generateRssContent?date=2026-07-30'), e);
        assert.equal(response.status, 200);
        assert.ok(files.has('rss/2026-07-30.md'));

        response = await worker.fetch(new Request('https://example.test/writeRssData?date=2026-07-30'), e);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).report_date, '2026-07-30');

        response = await worker.fetch(new Request('https://example.test/rss?days=1'), e);
        assert.equal(response.status, 200);
        const xml = await response.text();
        assert.match(xml, /<rss version="2.0"/);
        assert.match(xml, /2026-07-30日刊/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
