# TODO before release:
    
## Voice Box
    - Needs to know where it is (zone). So it can controll devices within it's own zone if the user didn't specify the zone.

## Add donate button

## Create Homey Community Topic ?

## Set description

## Create flow cards

### WHEN
    - Device starts listening
    - Device stops listening
    - Device starts playback (of wav file)
    - Device ends playback (of wav file)
    
### AND
    - Device is listening
    - Device is playing
    - Device is muted

### THEN
    - Device start listening. Output as wav or text
    - Device begin playback for wav or text
    - Device set volume
    - Device set mute (on/off)

    - App trigger Agent with text prompt. Output as wav or text


# ESPClient
    - Try to push a url at the device without it being triggered first.
        - This works!
          this.run_start();
          this.playAudioFromUrl('https://github.com/RealDeco/xiaozhi-esphome/raw/refs/heads/main/sounds/timer_finished.flac', false);
          this.run_end();


## Homey-log
    - What is it?
    - Do we need it?
    - https://www.npmjs.com/package/homey-log



## New AI tool - Change settings (lot's of work, but would be cool)
    - Need to expose as a tool what settings can be changed by the agent.
    - Allowed settings are 'voice', 'language' and 'optional_ai_instructions'
    - Example:
      - User: "I want to change your voice"
      - Agent: "Sure, you can change my voice to alloy, ash, ballad, ... " 
        - This uses a tool to get all allowed voices from setting manager.
        - Also needs a tool to keep converation alive. Set a flag or something, that will set VoiceAssistantAnnounceRequest.startConverstion to "true".
      - User: "alloy"
      - Agent: "Changing voice to alloy"
        - Another tool. Will set {voice: "alloy"}.
        - And then the agent completes it's run.
        - Then after the agent is done do the actual change.
          - Socket will reconnect
        - Have the agent speak back with a new voice?
  - 












# TODO after release

## Locally hosted AI
    - Whipsper
    - Piper
    - Ollama 
      - as an realtime agent?
      - using gpt-oss? (omg!)

## Agent tools
    - Start flow by name, "start <flow name>"
    - Start flow by synonym, "i'm going to bed" -> starts flow "night mode" - Need some way of letting user create connections between synonym and flow name

## Alarm or count down
    - This would be really nice to have
    - Looks like i can create alarm in the homey api:
        https://athombv.github.io/node-homey-api/HomeyAPIV3Local.ManagerAlarms.html
    - The AI could create an alarm based on the users wish. Either as at a specific time, or a calculated time based on count down value. The name of the alarm should be something that the AI will recognize, like "AI ALARM #001" or something
    - Then create a simple flow:
        When "Any alarm goes off" -> Then "AI agent handle alarm", and passing in the @name of the alarm that was the trigger.
    - If the AI recognizes the alarm, it looks for what it was supposed to do when that happended "by the name we gave the alarm".
        - Agent needs some kind of long term memory
        - Can homey run Sqlite? Is there something built in i can use?
        - Creating text files would also work.
    - Then delete the alarm

# Support ESPHome Api key
    - If anyone asks for it...



## Voice Box
    - Still some issue with silence detection
    - Still issue with LED feedback when playing multiple URL's
    - Voice box should tell when it's done playing the last URL 
      - How to do this?


# Phase 2

## Image analysis?
    - Use AI agent to analyze an image together with a prompt? "Can you se any persons in the surveillance image?", "Is it dark out", "Who is at the door?"

## Sound effects?
    - Host some wav files on github, that can be played by the voice box (just push an wav url at it.) Would need some index to read..

## Tools?
    - Web search tool, have the Agent do a web search for some information. "What movies are in the cinema today?" (with geo location it could find the nearest one)
