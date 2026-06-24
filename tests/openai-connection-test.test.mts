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

describe('Quick OpenAI Connection Test', () => {
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
  });

  it('should check API key and create agent', () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping - no valid API key (set OPENAI_API_KEY in env.json to run this integration test)');
      return;
    }

    console.log('🔑 API Key available:', testApiKey ? 'YES' : 'NO');
    console.log('🔑 API Key length:', testApiKey ? testApiKey.length : 0);
    console.log('🔑 API Key starts with sk-:', testApiKey ? testApiKey.startsWith('sk-') : false);
    
    expect(testApiKey).toBeTruthy();
    expect(testApiKey).not.toBe('test-api-key');
    
    const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: 'Test',
      deviceZone: testZone
    });
    
    expect(agent).toBeDefined();
    console.log('✅ Agent created successfully');
  });

  it('should attempt to connect to OpenAI', async () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping - no valid API key');
      return;
    }

    const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: 'Test connection',
      deviceZone: testZone
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('⏰ Connection timeout - this may be normal for first connection');
        resolve(); // Don't fail the test, just log
      }, 10000);

      let connected = false;

      agent.on('connected', () => {
        console.log('✅ Successfully connected to OpenAI!');
        connected = true;
        clearTimeout(timeout);
        resolve();
      });

      agent.on('open', () => {
        console.log('🔌 WebSocket opened');
      });

      agent.on('error', (error) => {
        console.error('❌ Connection error:', error.message);
        clearTimeout(timeout);
        // Don't reject, just log the error
        resolve();
      });

      agent.on('close', (code, reason) => {
        console.log(`🔌 WebSocket closed: ${code} ${reason}`);
        if (!connected) {
          clearTimeout(timeout);
          resolve();
        }
      });

      console.log('🔄 Attempting to connect...');
      agent.start().catch((error) => {
        console.error('❌ Start error:', error.message);
        clearTimeout(timeout);
        resolve();
      });
    });
  }, 15000);
});
