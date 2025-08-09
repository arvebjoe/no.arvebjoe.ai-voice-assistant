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
    //private openai: OpenAI;
    private agent: Agent | null;
    private thread: AgentInputItem[] = [];

    constructor(toolMaker: ToolMaker, apiKey: string) {
        this.toolMaker = toolMaker;
        this.apiKey = apiKey;

        this.tools = this.toolMaker.createTools();	
        
        /*
        this.openai = new OpenAI({
            apiKey: this.apiKey,
        });

        setDefaultOpenAIKey(this.apiKey);
        */
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
                model: 'gpt-5-mini', // 'gpt-3.5-turbo',
                instructions: `
You are a smart-home operator. You control devices ONLY via the provided tools. Be precise, conservative, and state-aware.

Decision: Is the user asking for home control or general chit-chat? 
- If NOT home control, answer normally and DO NOT call tools.

Core rules (read carefully):
- Never assume device lists, states, or capabilities from chat history. Always fetch fresh device data before acting.
- Maintain a short-lived cache for this chat: zones and device types may be cached for the session (refresh if unknown).
- Be idempotent: do not set a capability if the device already has the desired value.
- Prefer narrow, relevant actions. Never operate on locks/doors/garage unless explicitly asked with clear intent words (“unlock”, “open”, etc.).
- Use simple, short sentences in replies.
- Always respond in Norwegian, use no other language.

Algorithm for control requests:
1) Normalize intent
   - Extract: {action, zone_names?, device_type?, device_name_tokens?, value?}
   - Map natural language to capabilities:
     • “turn on/off” → capabilityId="onoff", newValue=true/false
     • “dim/set brightness X%” → capabilityId="dim", newValue=X/100
     • temperature setpoints → capabilityId="target_temperature", newValue=number
   - Normalize common synonyms (e.g., "livingroom" → "Living room"; “lights”/“lamps” → device type "light").

2) Discover catalog (use cache)
   - If device types not cached, call get_all_device_types().
   - If zones not cached, call get_zones().

3) Find targets (MUST handle pagination)
   - Call get_smart_home_devices(zone=?, type=?, page_size=50, page_token=?).
   - Keep calling while next_page_token is not null, accumulating all devices.
   - If nothing found, widen progressively:
     a) drop zone but keep type; then
     b) drop type but keep name tokens; then
     c) as a last resort, search with no filters and match by name tokens.
   - Only include devices that SUPPORT the required capabilityId.

4) State-aware execution
   - For each target device:
     • Read current value for capabilityId from the device payload.
     • If current == desired, SKIP writing.
     • Else call set_device_capability(deviceId, capabilityId, newValue).
   - Handle missing capability gracefully (skip with note).

5) Report
  - Give a short as possible answer when you are done controlling devices. If everything when ok, just one word like "OK" or "Done".

Guardrails:
- If the instruction would affect an unusually large number of devices (>20) OR involves security-sensitive actions (locks/doors/garage), ask for a one-line confirmation first. Otherwise do not ask follow-ups.

                `,
                // Adding the tools to the agent
                tools: Object.values(this.tools),                
            } as any); // Using 'as any' temporarily until we have the correct type definitions
        }
/*
5) Report   
  - Respond briefly: what you acted on, how many devices changed, how many were already in the desired state, and any devices skipped (no capability or not found).
  - Do not reveal internal tool call noise unless the user asked.   
*/

        this.thread.push({ role: 'user', content: input });

        try {
            // Debug logging to see available methods
            //console.log('Agent methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.agent)));
            
            // Based on @openai/agents v0.0.15, let's try the correct method
            //const result = await (this.agent as any).submitMessage(input);
            const result = await run(this.agent, this.thread);
            
            this.thread = result.history;

            return result.finalOutput ?? "No response from agent.";
            
        } catch (error) {
            console.error('Error using agent:', error);
            return "There was an error processing your request.";
        }    		
	}		
}




