'use strict';

require('dotenv').config();
const HomeyClient = require('./homey-client');
const fs = require('fs').promises;
const path = require('path');

// Initialize the HomeyClient
const homeyClient = new HomeyClient('192.168.0.99', 7709);

/**
 * Create a simplified OpenAI Assistant using the OpenAI API directly
 */
async function main() {
  try {
    console.log('Starting main function...');
    
    // Import OpenAI module dynamically (ES Module)
    const { OpenAI } = await import('openai');
    
    // Initialize the OpenAI client
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    console.log('OpenAI client initialized');

    // Initialize HomeyClient
    await homeyClient.initialize();
    console.log('HomeyClient initialized');

    // Create an Assistant or use an existing one
    const assistantFilePath = path.join(__dirname, 'assistant-id.json');
    let assistant;
    
    try {
      const assistantData = await fs.readFile(assistantFilePath, 'utf8');
      const assistantId = JSON.parse(assistantData).id;
      assistant = await openai.beta.assistants.retrieve(assistantId);
      console.log('Using existing assistant:', assistant.id);
    } catch (error) {
      // Create a new assistant
      console.log('Creating new assistant...');
      assistant = await openai.beta.assistants.create({
        name: "Smart Home Assistant",
        description: "An assistant that helps control smart home devices",
        model: "gpt-4-0125-preview",
        instructions: `
          You are a helpful smart home assistant. You can control devices in the user's home using the tools provided.
          
          When the user asks to control a device:
          1. First check what types of devices are available using getAllDeviceTypes()
          2. If needed, check what zones exist using getZones()
          3. Find the relevant devices using getSmartHomeDevices()
          4. Control the devices using setDeviceCapability()
          
          Common device capabilities:
          - lights: "onoff" (true/false), "dim" (0-1)
          - locks: "locked" (true/false)
          - thermostats: "target_temperature" (number)
          - plugs/sockets: "onoff" (true/false)
          
          Respond in a natural, helpful way. After completing an action, confirm what you did in a friendly manner.
          If you can't find a matching device or the request is unclear, ask for clarification.
          If the user asks a question unrelated to home automation, just answer normally without using the tools.
          
          Always start by determining whether the request involves smart home control or is just a general question.
        `,
        tools: [
          {
            type: "function",
            function: {
              name: "getSmartHomeDevices",
              description: "Get a list of smart home devices, optionally filtered by zone and/or type",
              parameters: {
                type: "object",
                properties: {
                  zone: {
                    type: "string",
                    description: "Filter devices by zone name (e.g., 'Kitchen', 'Bedroom')",
                  },
                  type: {
                    type: "string",
                    description: "Filter devices by device type (e.g., 'light', 'lock', 'sensor')",
                  },
                  page_size: {
                    type: "integer",
                    description: "Number of devices per page (1-100)",
                    default: 25,
                  },
                  page_token: {
                    type: "string",
                    description: "Token for the next page of results",
                  },
                },
                required: [],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "getAllDeviceTypes",
              description: "Get a list of all device types available in the system",
              parameters: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "getZones",
              description: "Get a list of all zones in the smart home",
              parameters: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "setDeviceCapability",
              description: "Set a capability value for a device",
              parameters: {
                type: "object",
                properties: {
                  deviceId: {
                    type: "string",
                    description: "The ID of the device to update",
                  },
                  capabilityId: {
                    type: "string",
                    description: "The capability ID to set (e.g., 'onoff', 'dim', 'locked')",
                  },
                  newValue: {
                    type: ["boolean", "number", "string"],
                    description: "The new value to set for the capability. Use true/false for boolean capabilities like 'onoff' or 'locked', numbers for 'dim' (0-1)",
                  },
                },
                required: ["deviceId", "capabilityId", "newValue"],
              },
            },
          },
        ],
      });
      
      // Save the assistant ID
      await fs.writeFile(
        assistantFilePath,
        JSON.stringify({ id: assistant.id }),
        'utf8'
      );
      console.log('New assistant created:', assistant.id);
    }
    
    // Create a new thread
    const thread = await openai.beta.threads.create();
    console.log('Thread created:', thread.id);
    
    // Process a user message
    const userMessage = "What types of devices do I have in my home?";
    console.log(`\nUser: ${userMessage}`);
    
    // Add the message to the thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userMessage,
    });
    
    // Run the assistant on the thread
    console.log('Starting assistant run...');
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistant.id,
    });
    
    // Check run status and process
    let runStatus = await checkRunStatus(openai, thread.id, run.id);
    
    // Handle tool calls if needed
    if (runStatus.status === "requires_action" && 
        runStatus.required_action?.type === "submit_tool_outputs") {
      console.log('Run requires tool outputs');
      
      const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
      const toolOutputs = [];
      
      for (const toolCall of toolCalls) {
        console.log(`Processing tool call: ${toolCall.function.name}`);
        
        // Execute the function
        const functionResponse = await executeFunction(
          toolCall.function.name, 
          JSON.parse(toolCall.function.arguments)
        );
        
        toolOutputs.push({
          tool_call_id: toolCall.id,
          output: JSON.stringify(functionResponse),
        });
      }
      
      // Submit the tool outputs
      console.log('Submitting tool outputs...');
      await openai.beta.threads.runs.submitToolOutputs({
        thread_id: thread.id,
        run_id: run.id,
        tool_outputs: toolOutputs,
      });
      
      // Continue checking status until complete
      runStatus = await checkRunStatus(openai, thread.id, run.id);
    }
    
    // Get the assistant's response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessages = messages.data.filter(msg => msg.role === "assistant");
    
    if (assistantMessages.length > 0) {
      const latestMessage = assistantMessages[0];
      console.log(`\nAssistant: ${latestMessage.content[0].text.value}`);
    } else {
      console.log("\nNo assistant response received.");
    }
    
    console.log('Main function completed');
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Helper function to check run status with polling
async function checkRunStatus(openai, threadId, runId) {
  console.log(`Checking run status for thread ${threadId} and run ${runId}`);
  
  try {
    // The OpenAI SDK expects a params object, not positional parameters
    let runStatus = await openai.beta.threads.runs.retrieve({
      thread_id: threadId,
      run_id: runId,
    });
    
    console.log('Initial run status:', runStatus.status);
    
    // Poll for status changes
    while (["queued", "in_progress"].includes(runStatus.status)) {
      // Wait 1 second before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve({
        thread_id: threadId,
        run_id: runId,
      });
      console.log('Updated run status:', runStatus.status);
    }
    
    return runStatus;
  } catch (error) {
    console.error('Error checking run status:', error);
    throw error;
  }
}

// Execute function based on the tool call
async function executeFunction(functionName, args) {
  console.log(`Executing function ${functionName} with args:`, args);
  
  switch (functionName) {
    case "getSmartHomeDevices":
      return await homeyClient.getSmartHomeDevices(
        args.zone,
        args.type,
        args.page_size,
        args.page_token
      );
      
    case "getAllDeviceTypes":
      return await homeyClient.getAllDeviceTypes();
      
    case "getZones":
      return await homeyClient.getZones();
      
    case "setDeviceCapability":
      await homeyClient.setDeviceCapability(
        args.deviceId,
        args.capabilityId,
        args.newValue
      );
      return { 
        success: true,
        message: `Set ${args.capabilityId} to ${args.newValue} for device ${args.deviceId}`
      };
      
    default:
      throw new Error(`Function ${functionName} not implemented`);
  }
}

// Export the main function
module.exports = { main };

// Run the main function if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
  });
}
