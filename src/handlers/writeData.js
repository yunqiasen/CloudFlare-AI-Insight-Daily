// src/handlers/writeData.js
import { getISODate, getFetchDate } from '../helpers.js';
import { fetchAllData, fetchDataByCategory, dataSources } from '../dataFetchers.js'; // 导入 fetchDataByCategory 和 dataSources
import { getFromKV, storeInKV } from '../kv.js';

function hasChineseText(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
}

async function preserveProjectTranslations(kv, key, items) {
    const previous = await getFromKV(kv, key) || [];
    const previousById = new Map(previous.map(item => [item.url || item.title, item]));
    return items.map(item => {
        if (hasChineseText(item.description)) return item;
        const oldItem = previousById.get(item.url || item.title);
        if (!oldItem || !hasChineseText(oldItem.description)) return item;
        return {
            ...item,
            description: oldItem.description,
            details: { ...item.details, translationStatus: 'cached' },
        };
    });
}

function buildCountFields(dataToStore) {
    const counts = Object.fromEntries(
        Object.entries(dataToStore).map(([key, value]) => [`${key}ItemCount`, value.length]),
    );
    if (dataToStore.project) {
        counts.projectChineseDescriptionCount = dataToStore.project.filter(item => hasChineseText(item.description)).length;
    }
    return counts;
}

export async function handleWriteData(request, env) {
    const dateParam = getFetchDate();
    const dateStr = dateParam ? dateParam : getISODate();
    console.log(`Starting /writeData process for date: ${dateStr}`);
    let category = null;
    let foloCookie = null;
    
    try {
        // 尝试解析请求体，获取 category 参数
        if (request.headers.get('Content-Type')?.includes('application/json')) {
            const requestBody = await request.json();
            category = requestBody.category;
            foloCookie = requestBody.foloCookie; // 获取 foloCookie
        }

        if (category && !Object.hasOwn(dataSources, category)) {
            return new Response(JSON.stringify({
                success: false,
                message: `Unknown data category: ${category}`,
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const foloCategories = new Set(['news', 'paper', 'socialMedia']);
        if ((!category || foloCategories.has(category)) && !foloCookie) {
            return new Response(JSON.stringify({
                success: false,
                message: 'Folo Cookie is required for news, paper and socialMedia data sources.',
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        console.log(`Starting /writeData process for category: ${category || 'all'} with foloCookie presence: ${!!foloCookie}`);

        let dataToStore = {};
        let fetchPromises = [];
        const errors = [];
        const storedCategories = [];
        let successMessage = '';

        if (category) {
            // 只抓取指定分类的数据
            const result = await fetchDataByCategory(env, category, foloCookie); // 传递 foloCookie
            let fetchedData = result.items;
            errors.push(...result.errors);
            if (category === 'project') {
                fetchedData = await preserveProjectTranslations(env.DATA_KV, `${dateStr}-project`, fetchedData);
            }
            dataToStore[category] = fetchedData;
            if (result.errors.length === 0 || fetchedData.length > 0) {
                fetchPromises.push(storeInKV(env.DATA_KV, `${dateStr}-${category}`, fetchedData));
                storedCategories.push(category);
            }
            successMessage = `Data for category '${category}' fetched${storedCategories.includes(category) ? ' and stored' : ''}.`;
            console.log(`Transformed ${category}: ${fetchedData.length} items.`);
        } else {
            // 抓取所有分类的数据 (现有逻辑)
            const result = await fetchAllData(env, foloCookie); // 传递 foloCookie
            const allUnifiedData = result.data;
            errors.push(...result.errors);
            
            for (const sourceType in dataSources) {
                if (Object.hasOwnProperty.call(dataSources, sourceType)) {
                    dataToStore[sourceType] = allUnifiedData[sourceType] || [];
                    if (sourceType === 'project') {
                        dataToStore[sourceType] = await preserveProjectTranslations(env.DATA_KV, `${dateStr}-project`, dataToStore[sourceType]);
                    }
                    if (!result.errorsByType[sourceType]?.length || dataToStore[sourceType].length > 0) {
                        fetchPromises.push(storeInKV(env.DATA_KV, `${dateStr}-${sourceType}`, dataToStore[sourceType]));
                        storedCategories.push(sourceType);
                    }
                    console.log(`Transformed ${sourceType}: ${dataToStore[sourceType].length} items.`);
                }
            }
            successMessage = `All data categories fetched and stored.`;
        }

        await Promise.all(fetchPromises);

        if (errors.length > 0) {
            console.warn("/writeData completed with errors:", errors);
            return new Response(JSON.stringify({ 
                success: false, 
                partial: Object.values(dataToStore).some(items => items.length > 0),
                message: `${successMessage} Some sources failed.`,
                storedCategories,
                errors: errors, 
                ...buildCountFields(dataToStore)
            }), {
                status: 502, headers: { 'Content-Type': 'application/json' }
            });
        } else {
            console.log("/writeData process completed successfully.");
            return new Response(JSON.stringify({ 
                success: true, 
                message: successMessage,
                storedCategories,
                ...buildCountFields(dataToStore)
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (error) {
        console.error("Unhandled error in /writeData:", error);
        return new Response(JSON.stringify({ success: false, message: "An unhandled error occurred during data processing.", error: error.message, details: error.stack }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
}
