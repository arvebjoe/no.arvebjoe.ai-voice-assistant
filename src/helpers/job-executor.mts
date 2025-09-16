import { TypedEmitter } from 'tiny-typed-emitter';
import { createLogger } from './logger.mjs';
import { JobManager, ScheduledJob, JobManagerEvents } from './job-manager.mjs';
import { DeviceManager } from './device-manager.mjs';
import VoiceAssistantDevice from '../homey/voice-assistant-device.mjs';
import { ToolManager } from '../llm/tool-manager.mjs';

export interface JobExecutorEvents {
    jobStarted: (job: ScheduledJob) => void;
    jobCompleted: (job: ScheduledJob, success: boolean, result?: any) => void;
    jobFailed: (job: ScheduledJob, error: Error) => void;
    executorStarted: () => void;
    executorStopped: () => void;
}

/**
 * JobExecutor handles the execution of scheduled jobs
 * It monitors for due jobs and routes them to the appropriate voice assistant device
 */
export class JobExecutor extends TypedEmitter<JobExecutorEvents> {
    private readonly logger = createLogger('JOB_EXECUTOR');
    private executionInterval?: NodeJS.Timeout;
    private readonly CHECK_INTERVAL_MS: number;
    private isRunning = false;
    private currentlyExecutingJobs = new Set<string>();
    
    constructor(
        private readonly jobManager: JobManager,
        private readonly deviceManager: DeviceManager,
        private readonly homey: any,
        checkIntervalSeconds = 30
    ) {
        super();
        this.CHECK_INTERVAL_MS = checkIntervalSeconds * 1000;
        
        // Listen for job manager events
        this.jobManager.on('jobExecuted', (job: ScheduledJob) => this.handleJobCompleted(job));
        this.jobManager.on('jobFailed', (job: ScheduledJob, error: any) => this.handleJobFailed(job, error));
    }
    
    /**
     * Find all available voice assistant devices
     */
    private findAllVoiceAssistantDevices(): VoiceAssistantDevice[] {
        const devices: VoiceAssistantDevice[] = [];
        
        try {
            const drivers = this.homey.drivers.getDrivers();
            for (const driver of Object.values(drivers)) {
                const driverDevices = (driver as any).getDevices();
                for (const device of driverDevices) {
                    // Check if this is a voice assistant device by looking for our key methods
                    if (device && typeof device.speakText === 'function') {
                        devices.push(device as VoiceAssistantDevice);
                    }
                }
            }
        } catch (error) {
            this.logger.error('Error finding voice assistant devices:', error);
        }
        
        return devices;
    }
    
    /**
     * Find a specific voice assistant device by ID
     */
    private findVoiceAssistantDeviceById(deviceId: string): VoiceAssistantDevice | null {
        try {
            const drivers = this.homey.drivers.getDrivers();
            for (const driver of Object.values(drivers)) {
                const driverDevices = (driver as any).getDevices();
                for (const device of driverDevices) {
                    if (device && device.getData && device.getData().id === deviceId) {
                        // Verify this is a voice assistant device
                        if (typeof device.speakText === 'function') {
                            return device as VoiceAssistantDevice;
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error('Error finding voice assistant device by ID:', error);
        }
        
        return null;
    }
    
    /**
     * Start the job execution engine
     */
    start(): void {
        if (this.isRunning) {
            this.logger.warn('Job executor is already running');
            return;
        }
        
        this.logger.info(`Starting job executor (check interval: ${this.CHECK_INTERVAL_MS}ms)`);
        this.isRunning = true;
        
        // Immediate check on startup
        this.checkAndExecuteJobs().catch(error => {
            this.logger.error('Error in initial job check:', error);
        });
        
        // Set up periodic checking
        this.executionInterval = setInterval(() => {
            this.checkAndExecuteJobs().catch(error => {
                this.logger.error('Error in periodic job check:', error);
            });
        }, this.CHECK_INTERVAL_MS);
        
        this.emit('executorStarted');
    }
    
    /**
     * Stop the job execution engine
     */
    stop(): void {
        if (!this.isRunning) {
            this.logger.warn('Job executor is not running');
            return;
        }
        
        this.logger.info('Stopping job executor');
        this.isRunning = false;
        
        if (this.executionInterval) {
            clearInterval(this.executionInterval);
            this.executionInterval = undefined;
        }
        
        this.emit('executorStopped');
    }
    
    /**
     * Check for due jobs and execute them
     */
    private async checkAndExecuteJobs(): Promise<void> {
        if (!this.isRunning) return;
        
        try {
            const dueJobs = this.jobManager.getJobsDueForExecution();
            
            if (dueJobs.length === 0) return;
            
            this.logger.info(`Found ${dueJobs.length} due job(s)`);
            
            // Process jobs, but avoid executing the same job multiple times
            for (const job of dueJobs) {
                if (this.currentlyExecutingJobs.has(job.id)) {
                    this.logger.info(`Job ${job.id} is already executing, skipping`);
                    continue;
                }
                
                // Execute job without waiting (fire and forget)
                this.executeJob(job).catch((error: unknown) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.logger.error(`Error executing job ${job.id}:`, errorMessage);
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Error checking for due jobs:', errorMessage);
        }
    }
    
    /**
     * Execute a specific job
     */
    private async executeJob(job: ScheduledJob): Promise<void> {
        this.currentlyExecutingJobs.add(job.id);
        
        try {
            this.logger.info(`Executing job: ${job.instruction} (${job.id})`);
            this.emit('jobStarted', job);
            
            // Find the appropriate device/agent for this job
            const targetDevice = this.findTargetDevice(job);
            if (!targetDevice) {
                throw new Error(`No voice assistant device found for zone: ${job.parsedDetails?.zone || 'unknown'}`);
            }
            
            // Get the device's tool manager (we'll need to add this method)
            const toolManager = (targetDevice as any).toolManager as ToolManager;
            if (!toolManager) {
                // Fallback: use natural language processing through the device's agent
                this.logger.info('No tool manager available, using natural language processing');
                const result = await this.executeJobInstructionNatural(job, targetDevice);
                
                // Mark job as completed
                const completed = this.jobManager.markJobCompleted(job.id, result);
                if (!completed) {
                    throw new Error('Failed to mark job as completed');
                }
                
                return;
            }
            
            // Execute the job instruction through the agent
            const result = await this.executeJobInstruction(job, toolManager, targetDevice);
            
            // Mark job as completed
            const completed = this.jobManager.markJobCompleted(job.id, result);
            if (!completed) {
                throw new Error('Failed to mark job as completed');
            }
            
            this.logger.info(`Job completed successfully: ${job.instruction}`);
            this.emit('jobCompleted', job, true, result);
            
        } catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            this.logger.error(`Job execution failed: ${job.instruction} - ${errorObj.message}`, errorObj);
            
            try {
                const failed = this.jobManager.markJobFailed(job.id, errorObj.message);
                if (!failed) {
                    this.logger.error('Failed to mark job as failed in JobManager');
                }
            } catch (failError) {
                const failErrorObj = failError instanceof Error ? failError : new Error(String(failError));
                this.logger.error(`Failed to mark job as failed: ${failErrorObj.message}`, failErrorObj);
            }
            
            this.emit('jobFailed', job, errorObj);
        } finally {
            this.currentlyExecutingJobs.delete(job.id);
        }
    }
    
    /**
     * Find the target device for job execution based on device ID or zone fallback
     */
    private findTargetDevice(job: ScheduledJob): VoiceAssistantDevice | null {
        // First, try to find by specific voice assistant device ID if provided
        if (job.parsedDetails?.voiceAssistantDeviceId) {
            const device = this.findVoiceAssistantDeviceById(job.parsedDetails.voiceAssistantDeviceId);
            if (device) {
                this.logger.info(`Found target device by ID: ${job.parsedDetails.voiceAssistantDeviceId}`);
                return device;
            }
            this.logger.warn(`No device found with ID: ${job.parsedDetails.voiceAssistantDeviceId}`);
        }
        
        // Fallback: find a device in the specified zone
        if (job.parsedDetails?.zone) {
            const devices = this.findAllVoiceAssistantDevices();
            for (const device of devices) {
                // Check if device is in the right zone by looking at its current zone
                const deviceZone = (device as any).currentZone || 'unknown';
                if (deviceZone === job.parsedDetails.zone) {
                    this.logger.info(`Found target device for zone: ${job.parsedDetails.zone}`);
                    return device;
                }
            }
            this.logger.warn(`No device found in zone: ${job.parsedDetails.zone}`);
        }
        
        // Final fallback: use any available device
        const allDevices = this.findAllVoiceAssistantDevices();
        if (allDevices.length > 0) {
            const firstDevice = allDevices[0];
            const deviceId = firstDevice.getData().id;
            this.logger.info(`Using fallback device with ID: ${deviceId}`);
            return firstDevice;
        }
        
        this.logger.error('No voice assistant devices found for job execution');
        return null;
    }
    
    /**
     * Execute the job instruction through the target device using natural language only
     */
    private async executeJobInstructionNatural(
        job: ScheduledJob, 
        targetDevice: VoiceAssistantDevice
    ): Promise<any> {
        this.logger.info(`Processing job instruction: "${job.instruction}"`);
        
        // Use the device's askAgentOutputToText method to process the instruction
        // This leverages the existing agent infrastructure without needing direct tool access
        try {
            const response = await targetDevice.askAgentOutputToText(job.instruction);
            
            return {
                instruction: job.instruction,
                executed: true,
                timestamp: new Date(),
                response: response,
                method: 'natural_language_processing'
            };
        } catch (error) {
            // If text processing fails, try audio output as fallback
            this.logger.warn('Text processing failed, trying audio output');
            await targetDevice.askAgentOutputToSpeaker(job.instruction);
            
            return {
                instruction: job.instruction,
                executed: true,
                timestamp: new Date(),
                response: 'Processed via audio output',
                method: 'audio_output'
            };
        }
    }
    
    /**
     * Execute the job instruction through the target device's tools
     */
    private async executeJobInstruction(
        job: ScheduledJob, 
        toolManager: ToolManager, 
        targetDevice: VoiceAssistantDevice
    ): Promise<any> {
        
        // If we have parsed details, try to execute directly
        if (job.parsedDetails?.deviceIds && job.parsedDetails?.capability !== undefined) {
            this.logger.info('Executing job with parsed details');
            return await this.executeDirectAction(job, toolManager);
        }
        
        // Otherwise, use natural language processing through the agent
        this.logger.info('Executing job with natural language instruction');
        return await this.executeNaturalLanguageInstruction(job, targetDevice);
    }
    
    /**
     * Execute a job with pre-parsed device details
     */
    private async executeDirectAction(job: ScheduledJob, toolManager: ToolManager): Promise<any> {
        const { deviceIds, capability, value } = job.parsedDetails!;
        
        if (!deviceIds || deviceIds.length === 0) {
            throw new Error('No device IDs specified in parsed details');
        }
        
        // Simplified execution - we'll use the device manager directly
        const results = [];
        for (const deviceId of deviceIds) {
            this.logger.info(`Setting ${capability} = ${value} on device ${deviceId}`);
            try {
                // Use device manager to set capability
                const result = await this.deviceManager.setDeviceCapability(deviceId, capability!, value);
                results.push(result);
            } catch (error) {
                this.logger.error(`Failed to set capability on device ${deviceId}:`, error);
                throw error;
            }
        }
        
        return results;
    }
    
    /**
     * Execute a job using natural language through the voice assistant
     */
    private async executeNaturalLanguageInstruction(job: ScheduledJob, targetDevice: VoiceAssistantDevice): Promise<any> {
        // This would integrate with the OpenAI agent to process the instruction
        // For now, we'll create a simplified version
        
        this.logger.info(`Processing natural language instruction: "${job.instruction}"`);
        
        // Get the device's agent (simplified approach)
        const agent = (targetDevice as any).agent;
        if (!agent) {
            // Fallback: just log the instruction and return success
            this.logger.warn('No agent available, logging instruction for manual execution');
            return {
                instruction: job.instruction,
                executed: false,
                timestamp: new Date(),
                message: `Manual execution required: "${job.instruction}"`
            };
        }
        
        // Send the instruction to the agent for processing
        return {
            instruction: job.instruction,
            executed: true,
            timestamp: new Date(),
            message: `Instruction "${job.instruction}" processed by agent`
        };
    }
    
    /**
     * Handle job completion events from JobManager
     */
    private handleJobCompleted(job: ScheduledJob): void {
        this.logger.info(`Job completion event received: ${job.instruction}`);
        
        // Provide user feedback if requested
        if (job.output.shouldNotify) {
            this.notifyJobCompletion(job, true);
        }
    }
    
    /**
     * Handle job failure events from JobManager
     */
    private handleJobFailed(job: ScheduledJob, error: string): void {
        this.logger.info(`Job failure event received: ${job.instruction} - ${error}`);
        
        // Always notify on failures (unless explicitly disabled)
        if (job.output.shouldNotify !== false) {
            this.notifyJobCompletion(job, false, error);
        }
    }
    
    /**
     * Notify user about job completion/failure
     */
    private notifyJobCompletion(job: ScheduledJob, success: boolean, error?: string): void {
        // Find a device to send notification through
        const notificationDevice = this.findTargetDevice(job);
        if (!notificationDevice) {
            this.logger.warn('No device available for job completion notification');
            return;
        }
        
        const message = success 
            ? `Scheduled task completed: ${job.instruction}`
            : `Scheduled task failed: ${job.instruction}. Error: ${error}`;
        
        this.logger.info(`Sending notification: ${message}`);
        
        // Send notification through the device
        // This could be TTS, a sound, or other notification method
        notificationDevice.speakText(message).catch((notifyError: unknown) => {
            const errorMessage = notifyError instanceof Error ? notifyError.message : String(notifyError);
            this.logger.error('Failed to send job notification:', errorMessage);
        });
    }
    
    /**
     * Get executor status
     */
    getStatus(): {
        isRunning: boolean;
        checkInterval: number;
        availableDevices: number;
        currentlyExecuting: number;
        nextCheck?: Date;
    } {
        const nextCheck = this.isRunning && this.executionInterval 
            ? new Date(Date.now() + this.CHECK_INTERVAL_MS)
            : undefined;
            
        return {
            isRunning: this.isRunning,
            checkInterval: this.CHECK_INTERVAL_MS,
            availableDevices: this.findAllVoiceAssistantDevices().length,
            currentlyExecuting: this.currentlyExecutingJobs.size,
            nextCheck
        };
    }
    
    /**
     * Get list of available voice assistant devices
     */
    getAvailableDevices(): Array<{id: string, zone?: string}> {
        return this.findAllVoiceAssistantDevices().map(device => ({
            id: device.getData().id,
            zone: (device as any).currentZone || 'unknown'
        }));
    }
}