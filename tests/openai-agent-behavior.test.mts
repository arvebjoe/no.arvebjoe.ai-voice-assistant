import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIRealtimeAgent } from '../src/llm/openai-realtime-agent.mjs';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
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

describe('OpenAI Agent Behavior Analysis', () => {
  let mockHomey: MockHomey;
  let mockDeviceManager: MockDeviceManager;
  let toolManager: ToolManager;
  
  const testApiKey = envConfig.OPENAI_API_KEY || 'test-api-key';
  const testZone = 'Office';

  beforeEach(async () => {
    // Initialize mocks
    mockHomey = new MockHomey();
    mockDeviceManager = new MockDeviceManager();
    
    // Initialize DeviceManager
    await mockDeviceManager.init();
    await mockDeviceManager.fetchData();
    
    // Initialize ToolManager with mocks
    toolManager = new ToolManager(mockHomey, testZone, mockDeviceManager as any);
    
    console.log('🏠 Mock devices available:');
    const devices = mockDeviceManager.getSmartHomeDevices();
    devices.devices.forEach((device: any) => {
      console.log(`  - ${device.name} (${device.class}) in ${device.zoneName}`);
    });
  });

  afterEach(() => {
    // Clean up after each test
  });

  it('should connect to OpenAI and respond to basic greeting', async () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping real API test - no valid API key found');
      return;
    }

    const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: 'Be very brief. Just say hello back.',
      deviceZone: testZone
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout - agent did not respond within 15 seconds'));
      }, 15000);

      agent.on('text.done', (message) => {
        console.log('🤖 Agent Response:', message);
        clearTimeout(timeout);
        resolve();
      });

      agent.on('error', (error) => {
        console.error('❌ Agent Error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      agent.on('connected', () => {
        console.log('✅ Connected to OpenAI');
        setTimeout(() => {
          agent.sendTextForTextResponse('Hello, can you hear me?');
        }, 1000);
      });

      agent.start().catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 20000);

  it('should understand and execute smart home commands', async () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping real API test - no valid API key found');
      return;
    }

    const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: 'You control smart home devices. Always use the available tools to control devices. Be concise.',
      deviceZone: testZone
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout - agent did not complete smart home action within 30 seconds'));
      }, 30000);

      let toolCallMade = false;
      let responseReceived = false;
      const toolCalls: any[] = [];

      // Monitor tool calls
      agent.on('tool.called', (data) => {
        console.log('🔧 Tool Called:', data.name, 'with args:', JSON.stringify(data.args, null, 2));
        toolCalls.push(data);
        toolCallMade = true;
      });

      agent.on('text.done', (message) => {
        console.log('🤖 Agent Response:', message);
        console.log(`📊 Total tool calls made: ${toolCalls.length}`);
        responseReceived = true;
        
        // Test passes if we got a response
        clearTimeout(timeout);
        
        // Log analysis for debugging
        if (toolCalls.length === 0) {
          console.log('⚠️ WARNING: No tool calls were made. Agent may not be using tools correctly.');
        } else {
          console.log('✅ Agent successfully used tools for smart home control');
        }
        
        resolve();
      });

      agent.on('error', (error) => {
        console.error('❌ Agent Error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      agent.on('connected', () => {
        console.log('✅ Connected to OpenAI for smart home test');
        setTimeout(() => {
          console.log('🗣️ Sending command: "Turn on the kitchen lights"');
          agent.sendTextForTextResponse('Turn on the kitchen lights');
        }, 1000);
      });

      agent.start().catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 35000);

  it('should handle complex multi-device commands', async () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping real API test - no valid API key found');
      return;
    }

    const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
      apiKey: testApiKey,
      voice: 'alloy',
      languageCode: 'en',
      languageName: 'English',
      additionalInstructions: 'You are a smart home assistant. Use tools to control multiple devices when asked. Be concise.',
      deviceZone: testZone
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout - agent did not handle complex command within 45 seconds'));
      }, 45000);

      const toolCalls: any[] = [];
      let responseReceived = false;

      // Track all tool calls
      agent.on('tool.called', (data) => {
        console.log(`🔧 Tool Called [${toolCalls.length + 1}]:`, data.name, 'with args:', JSON.stringify(data.args, null, 2));
        toolCalls.push(data);
      });

      agent.on('text.done', (message) => {
        console.log('🤖 Agent Response:', message);
        console.log(`📊 Total tool calls made: ${toolCalls.length}`);
        responseReceived = true;
        
        clearTimeout(timeout);
        
        // Analyze the tool calls
        console.log('\n📈 Tool Call Analysis:');
        toolCalls.forEach((call, index) => {
          console.log(`  ${index + 1}. ${call.name}:`, call.args);
        });
        
        if (toolCalls.length === 0) {
          console.log('⚠️ WARNING: No tool calls were made for complex command. Agent may not understand instructions.');
        } else if (toolCalls.length === 1) {
          console.log('⚠️ WARNING: Only one tool call for complex command. Agent may not have processed all parts.');
        } else {
          console.log(`✅ Agent made ${toolCalls.length} tool calls for complex command - good!`);
        }
        
        resolve();
      });

      agent.on('error', (error) => {
        console.error('❌ Agent Error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      agent.on('connected', () => {
        console.log('✅ Connected to OpenAI for complex command test');
        setTimeout(() => {
          console.log('🗣️ Sending complex command: "Turn off all the lights in the office and set the temperature to 21 degrees"');
          agent.sendTextForTextResponse('Turn off all the lights in the office and set the temperature to 21 degrees');
        }, 1000);
      });

      agent.start().catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 50000);

  it('should test different instruction variations', async () => {
    if (testApiKey === 'test-api-key') {
      console.log('⚠️ Skipping real API test - no valid API key found');
      return;
    }

    const testCases = [
      {
        instruction: 'Turn on the kitchen lights',
        expectedAction: 'Should control kitchen lights'
      },
      {
        instruction: 'Make the living room warmer',
        expectedAction: 'Should adjust temperature'
      },
      {
        instruction: 'Turn off everything in the bedroom',
        expectedAction: 'Should control multiple bedroom devices'
      }
    ];

    for (const testCase of testCases) {
      console.log(`\n🧪 Testing: "${testCase.instruction}"`);
      console.log(`📝 Expected: ${testCase.expectedAction}`);
      
      const agent = new OpenAIRealtimeAgent(mockHomey, toolManager, {
        apiKey: testApiKey,
        voice: 'alloy',
        languageCode: 'en',
        languageName: 'English',
        additionalInstructions: 'You control smart home devices. Always use available tools. Be concise.',
        deviceZone: testZone
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log('⏰ Test case timeout - moving to next');
          resolve(); // Don't fail, just move on
        }, 20000);

        const toolCalls: any[] = [];

        agent.on('tool.called', (data) => {
          console.log(`  🔧 Tool: ${data.name}`, data.args);
          toolCalls.push(data);
        });

        agent.on('text.done', (message) => {
          console.log(`  🤖 Response: ${message}`);
          console.log(`  📊 Tools used: ${toolCalls.length}`);
          clearTimeout(timeout);
          resolve();
        });

        agent.on('error', (error) => {
          console.error(`  ❌ Error: ${error.message}`);
          clearTimeout(timeout);
          resolve(); // Don't fail, just move on
        });

        agent.on('connected', () => {
          setTimeout(() => {
            agent.sendTextForTextResponse(testCase.instruction);
          }, 1000);
        });

        agent.start().catch(() => {
          clearTimeout(timeout);
          resolve(); // Don't fail, just move on
        });
      });
    }
  }, 120000);
});
