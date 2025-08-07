import { Agent, AgentInputItem, run, setDefaultOpenAIKey } from '@openai/agents';
import { OpenAI } from 'openai';
import { ToolMaker } from './toolMaker.mjs';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class SmartAgent {
    private toolMaker: ToolMaker;
    private apiKey: string;
    private tools: ReturnType<ToolMaker['createTools']>;
    private openai: OpenAI;
    private agent: Agent | null;
    private thread: AgentInputItem[] = [];

    constructor(toolMaker: ToolMaker, apiKey: string) {
        this.toolMaker = toolMaker;
        this.apiKey = apiKey;

        this.tools = this.toolMaker.createTools();	
        
        this.openai = new OpenAI({
            apiKey: this.apiKey,
        });

        setDefaultOpenAIKey(this.apiKey);

        this.agent = null;
        this.thread = []; 
    }

    async initialize(): Promise<void> {
        // TODO: Needed?
    } 

    async run(input: string): Promise<string> {
        if (!this.agent) {
            // Create an agent with the OpenAI API
            this.agent = new Agent({
                // Correct Agent construction parameters based on @openai/agents library
                name: 'Smart Home Assistant',
                model: 'gpt-4.1-nano', // 'gpt-3.5-turbo',
                instructions: `
                    You are a helpful smart home assistant. You can control devices in the user's home using the tools provided.
                    When the user asks to control a device:

                    1. First check what types of devices are available using getAllDeviceTypes()
                    2. If needed, check what zones exist using getZones()
                    3. Find the relevant devices using getSmartHomeDevices(). Zone and Type are optional, but can help narrow down the search. But if you don't know the zone or type, you can leave them empty. Use a page size no smaller then 10. If this returns next_page_token, then there are more devices to fetch.
                    4. Control the devices using setDeviceCapability()
                    5. If the user asks about the weather, use getWeatherTool()
                    6. If the user asks for a fun fact, use historyFunFact()
                    7. IMPORTANT! Never rely on the chat history to determine device state or capabilities. Always use the getSmartHomeDevices() tool to get the latest information.

                    Common device capabilities:
                    - lights: "onoff" (true/false), "dim" (0-1)
                    - locks: "locked" (true/false)
                    - thermostats: "target_temperature" (number)
                    - plugs/sockets: "onoff" (true/false)

                    Use short sentences and simple language.
                    Never ask for a follow-up question.                    
                    If you can't find a matching device or the request is unclear, try doing a wider search using getSmartHomeDevices() without specific parameters.
                    If the user asks a question unrelated to home automation, just answer normally without using the tools.
                    Always start by determining whether the request involves smart home control or is just a general question.
                `,
                // Adding the tools to the agent
                tools: Object.values(this.tools),
            } as any); // Using 'as any' temporarily until we have the correct type definitions
        }

        this.thread.push({ role: 'user', content: input });

        try {
            // Debug logging to see available methods
            //console.log('Agent methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.agent)));
            
            // Based on @openai/agents v0.0.15, let's try the correct method
            //const result = await (this.agent as any).submitMessage(input);
            const result = await run(this.agent, this.thread );            
            
            this.thread = result.history;

            return result.finalOutput ?? "No response from agent.";
            
        } catch (error) {
            console.error('Error using agent:', error);
            return "There was an error processing your request.";
        }    		
	}		
}




