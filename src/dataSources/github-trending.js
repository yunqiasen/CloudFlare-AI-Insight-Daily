// src/dataSources/projects.js
import { fetchData, getISODate, removeMarkdownCodeBlock, formatDateToChineseWithTime, escapeHtml, stripHtml } from '../helpers.js';
import { callChatAPI } from '../chatapi.js';

function normalizeProjectsResponse(data) {
    if (Array.isArray(data)) return data;
    if (!Array.isArray(data?.items)) return [];
    return data.items.map((item) => {
        const title = item.title || String(item.id || '').replace(/^https:\/\/github\.com\//, '');
        const [owner = '', name = title] = title.split('/', 2);
        const html = String(item.content_html || item.content_text || item.summary || '').replace(/<img\b[^>]*>/gi, '');
        const text = stripHtml(html);
        const description = text.split(/\bLanguage:\s*/i)[0].trim();
        const language = text.match(/\bLanguage:\s*([^\n]+)/i)?.[1]?.trim() || '';
        const totalStars = text.match(/\bStars:\s*([\d,]+)/i)?.[1] || '';
        const forks = text.match(/\bForks:\s*([\d,]+)/i)?.[1] || '';
        return {
            owner: item.authors?.[0]?.name || owner,
            name,
            url: item.url || item.id,
            description: description.slice(0, 600),
            language,
            totalStars,
            forks,
            starsToday: '',
            builtBy: [],
        };
    });
}

const ProjectsDataSource = {
    fetch: async (env) => {
        console.log(`Fetching projects from: ${env.PROJECTS_API_URL}`);
        let projects;
        try {
            projects = normalizeProjectsResponse(await fetchData(env.PROJECTS_API_URL));
        } catch (error) {
            console.error("Error fetching projects data:", error.message);
            throw new Error(`Failed to fetch projects data: ${error.message}`);
        }

        if (!Array.isArray(projects)) {
            throw new Error("Invalid projects data format");
        }
         if (projects.length === 0) {
            console.log("No projects fetched from API.");
            return { items: [] };
        }

        if (env.OPEN_TRANSLATE !== "true") {
            console.warn("Skipping project translations.");
            return projects.map(p => ({ ...p, description_zh: p.description || "", translation_status: 'disabled' }));
        }

        const descriptionsToTranslate = projects
            .map(p => p.description || "")
            .filter(desc => typeof desc === 'string');

        const nonEmptyDescriptions = descriptionsToTranslate.filter(d => d.trim() !== "");
        if (nonEmptyDescriptions.length === 0) {
            console.log("No non-empty project descriptions to translate.");
            return projects.map(p => ({ ...p, description_zh: p.description || "", translation_status: 'empty' }));
        }
        const buildPrompt = (batch) => `Translate the following English project descriptions to Chinese.
Provide the translations as a JSON array of strings, in the exact same order as the input.
Each string in the output array must correspond to the string at the same index in the input array.
If an input description is an empty string, the corresponding translated string in the output array should also be an empty string.
Input Descriptions (JSON array of strings):
${JSON.stringify(batch)}
Respond ONLY with the JSON array of Chinese translations. Do not include any other text or explanations.
JSON Array of Chinese Translations:`;

        let translatedTexts = [];
        const batchSize = 8;
        for (let i = 0; i < descriptionsToTranslate.length; i += batchSize) {
            const batch = descriptionsToTranslate.slice(i, i + batchSize);
            try {
                console.log(`Requesting translation batch ${Math.floor(i / batchSize) + 1} (${batch.length} descriptions).`);
                const chatResponse = await callChatAPI(env, buildPrompt(batch));
                const parsedTranslations = JSON.parse(removeMarkdownCodeBlock(chatResponse));
                if (!Array.isArray(parsedTranslations) || parsedTranslations.length !== batch.length) {
                    throw new Error(`Translation count mismatch: expected ${batch.length}, received ${parsedTranslations?.length ?? 'null'}`);
                }
                translatedTexts.push(...parsedTranslations);
            } catch (translationError) {
                console.error("Failed to translate project description batch:", translationError.message);
                translatedTexts.push(...batch.map(() => null));
            }
        }

        return projects.map((project, index) => {
            const translated = translatedTexts[index];
            return {
                ...project,
                description_zh: (typeof translated === 'string') ? translated : (project.description || ""),
                translation_status: (typeof translated === 'string') ? 'translated' : 'fallback',
            };
        });
    },
    transform: (projectsData, sourceType) => {
        const unifiedProjects = [];
        const now = getISODate();
        if (Array.isArray(projectsData)) {
            projectsData.forEach((project, index) => {
                unifiedProjects.push({
                    id: index + 1, // Use project.url as ID if available
                    type: sourceType,
                    url: project.url,
                    title: project.name,
                    description: project.description_zh || project.description || "",
                    published_date: now, // Projects don't have a published date, use current date
                    authors: project.owner ? [project.owner] : [],
                    source: "GitHub Trending",
                    details: {
                        owner: project.owner,
                        name: project.name,
                        language: project.language,
                        languageColor: project.languageColor,
                        totalStars: project.totalStars,
                        forks: project.forks,
                        starsToday: project.starsToday,
                        builtBy: project.builtBy || [],
                        translationStatus: project.translation_status || 'unknown',
                    }
                });
            });
        }
        return unifiedProjects;
    },

    generateHtml: (item) => {
        return `
            <strong>${escapeHtml(item.title)}</strong> (所有者: ${escapeHtml(item.details.owner)})<br>
            <small>星标: ${escapeHtml(item.details.totalStars)} (今日: ${escapeHtml(item.details.starsToday)}) | 语言: ${escapeHtml(item.details.language || 'N/A')}</small>
            描述: ${escapeHtml(item.description) || 'N/A'}<br>
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">在 GitHub 上查看</a>
        `;
    }
};

export default ProjectsDataSource;
