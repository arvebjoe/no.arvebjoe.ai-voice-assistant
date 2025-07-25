const OpenAI = require('openai');
const { createLogger } = require('../logger');

const log = createLogger('GPT');

async function listModels(apiKey) {

    try {
        const openai = new OpenAI({ apiKey });
        const models = await openai.models.list();
        
        // Filter for chat models and exclude previews
        const chatModels = models.data.filter(model => {
            const id = model.id.toLowerCase();
            return (
                // Include GPT models that are likely chat models
                (id.includes('gpt-3.5') || id.includes('gpt-4')) &&
                // Exclude preview/test models
                !id.includes('preview') &&
                !id.includes('test') &&
                // Exclude specific non-chat variants
                !id.includes('instruct') &&
                !id.includes('search') &&
                !id.includes('audio') &&
                !id.includes('realtime')
            );
        });

        return chatModels.map(model => ({
            name: model.id,
            size: null,  // OpenAI doesn't provide model sizes
            modified: model.created * 1000,  // Convert to milliseconds
            type: 'chat'  // Add type for clarity
        }));
    } catch (err) {
        log.error('Error listing OpenAI models', err);
        return [];
    }
}

module.exports = {
  listModels
};

