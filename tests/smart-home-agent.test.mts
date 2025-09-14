import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIRealtimeAgent } from '../src/llm/openai-realtime-agent.mjs';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import fs from 'fs';
import path from 'path';

// Load environment variables from env.json
const envPath = path.join(process.cwd(), 'env.json');
let envConfig: any = {};

if (fs.existsSync(envPath)) {
    try {
        envConfig = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    } catch (error) {
        console.warn('Could not load env.json:', error);
    }
}

describe('OpenAI Smart Home Agent Test', () => {
    let mockHomey: MockHomey;
    let mockDeviceManager: MockDeviceManager;
    let mockGeoHelper: MockGeoHelper;
    let mockWeatherHelper: MockWeatherHelper;
    let toolManager: ToolManager;

    const testApiKey = envConfig.OPENAI_API_KEY || 'test-api-key';
    const testZone = 'Office';

    beforeEach(async () => {
        mockHomey = new MockHomey();
        mockDeviceManager = new MockDeviceManager();
        mockGeoHelper = new MockGeoHelper();
        mockWeatherHelper = new MockWeatherHelper();
        await mockDeviceManager.init();
        await mockDeviceManager.fetchData();
        await mockGeoHelper.init();
        await mockWeatherHelper.init();
        toolManager = new ToolManager(mockHomey, testZone, mockDeviceManager as any, mockGeoHelper as any, mockWeatherHelper as any);

        console.log('🏠 Available devices:');
        const devices = mockDeviceManager.getSmartHomeDevices();
        devices.devices.slice(0, 5).forEach((device: any) => {
            console.log(`  - ${device.name} in ${device.zone}`);
        });
        console.log(`  ... and ${devices.devices.length - 5} more devices`);
    });

    it('should test smart home command understanding', async () => {
        if (testApiKey === 'test-api-key') {
            console.log('⚠️ Skipping - no valid API key found');
            return;
        }

        console.log('\n🤖 Testing OpenAI Agent Smart Home Understanding');
        console.log('====================================================');


        

        const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
            apiKey: testApiKey,
            voice: 'alloy',
            languageCode: 'no',
            languageName: 'Norwegian',
            additionalInstructions: '',
            deviceZone: testZone
        });

        console.log('  🔄 Connecting to OpenAI...');

        // Wait for the agent to be ready - wait for "open" event
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout - agent did not open within 15 seconds'));
            }, 15000);

            agent.on('open', () => {
                console.log('  ✅ WebSocket connection opened');
                clearTimeout(timeout);
                resolve();
            });

            agent.on('error', (error) => {
                console.error(`  ❌ Connection error: ${error.message}`);
                clearTimeout(timeout);
                reject(error);
            });

            agent.start().catch((error) => {
                console.error(`  ❌ Start failed: ${error.message}`);
                clearTimeout(timeout);
                reject(error);
            });
        });

        console.log('  🎉 Agent is now ready to receive commands!');

        const testCommands = [
            //'Hello, how are you?'
            //'Turn on the kitchen lights',
            //'Turn the lights off'
            //'Slå av lysene'
            'Slå av lyset'
            //'Set the office temperature to 22 degrees'
        ];

        for (let i = 0; i < testCommands.length; i++) {
            const command = testCommands[i];
            console.log(`\n📝 Test ${i + 1}: "${command}"`);

            const result = await testSingleCommand(agent, command, 20000);
            console.log(`✅ Test ${i + 1} completed`);
            console.log(`📊 Tools called: ${result.toolCalls.length}`);
            console.log(`💬 Response: ${result.response || 'No response'}`);

            if (result.toolCalls.length > 0) {
                console.log('🔧 Tool calls made:');
                result.toolCalls.forEach((call: any, idx: number) => {
                    console.log(`  ${idx + 1}. ${call.name}: ${JSON.stringify(call.args)}`);
                });
            } else {
                console.log('⚠️  No tool calls made - agent may not understand the command');
            }

            // Small delay between tests
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('\n🎯 Test Analysis Complete!');
        console.log('Check the logs above to analyze how well the agent understands smart home commands.');

    }, 120000); // 2 minute timeout for the whole test
});

async function testSingleCommand(agent: OpenAIRealtimeAgent, command: string, timeoutMs: number = 15000): Promise<{ response: string | null; toolCalls: any[] }> {


    return new Promise((resolve, reject) => {

        const timeout = setTimeout(() => {
            console.log(`⏰ Command timed out after ${timeoutMs}ms`);
            resolve({ response: null, toolCalls: [] });
        }, timeoutMs);

        let response: string | null = null;
        const toolCalls: any[] = [];

        agent.on('tool.called', (data) => {
            console.log(`  🔧 Tool called: ${data.name}`, data.args);
            toolCalls.push(data);
        });

        agent.on('text.done', (message) => {
            console.log(`  🤖 Agent response received`);
            if (message.text) {
                response = message.text;
            } else {
                response = typeof message === 'string' ? message : JSON.stringify(message);
            }
            clearTimeout(timeout);
            resolve({ response, toolCalls });
        });

        agent.on('error', (error) => {
            console.error(`  ❌ Error: ${error.message}`);
            clearTimeout(timeout);
            reject({ response, toolCalls });
        });
        agent.sendTextForTextResponse(command);

    });

}
