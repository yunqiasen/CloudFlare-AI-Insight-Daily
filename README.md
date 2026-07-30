# 🚀 AI 资讯日报

> 您的每日 AI 信息整合,分析,日报,播客内容生成平台。

**AI 资讯日报** 是一个基于 **Cloudflare Workers** 的内容聚合与生成平台。它整合行业新闻、热门开源项目、论文和社交媒体内容，通过 Gemini 或 OpenAI Chat Completions 兼容模型生成日报、播客和 RSS，并可提交到 GitHub。

我们的目标是成为您在瞬息万变的 AI 浪潮中保持领先的得力助手，让您高效获取最有价值的信息。

> [!NOTE]
> 日报后端项目已全面迁移至该项目: [PrismFlowAgent](https://github.com/justlovemaki/PrismFlowAgent) , 原生支持AI操作，可docker部署
> 
> 日报前端项目已发布2.0: [Hextra-AI-Insight-Daily](https://github.com/justlovemaki/Hextra-AI-Insight-Daily) , 基于 Hugo 加 Hextra主题 构建。
> 
> 感谢阮一峰老师在[周刊352期](https://www.ruanyifeng.com/blog/2025/06/weekly-issue-352.html)的推荐。
>
> 全新日报站点：[hex2077.dev/](https://hex2077.dev/)

## 当前部署配置

- Worker：`ai-daily`
- KV：`ai-daily-data`
- AI：`https://openrouter.ai/api/v1` / `google/gemma-4-26b-a4b-it:free`
- GitHub Trending：`https://rss.xinghaihub.com/github/trending/daily/any?format=json`
- 生产地址：`https://daily.xinghaihub.com`

```bash
npm test
npm run check
npm run dev
npm run deploy
```

生产 Secret：`OPENAI_API_KEY`、`GITHUB_TOKEN`、`LOGIN_PASSWORD`。新闻、论文和社交平台来源依赖有效的 Folo Cookie；GitHub Trending 不需要。
