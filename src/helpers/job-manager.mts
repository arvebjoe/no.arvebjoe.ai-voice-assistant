import { EventEmitter } from "events";
import { TypedEmitter } from "tiny-typed-emitter";
import { createLogger } from './logger.mjs';
import { GeoHelper } from './geo-helper.mjs';

export interface ScheduledJob {
    /** Unique identifier for the job */
    id: string;
    
    /** When the job should execute */
    scheduledTime: Date;
    
    /** What action the agent should perform - natural language instruction */
    instruction: string;
    
    /** Pre-parsed details that the agent determined (optional) */
    parsedDetails?: {
        deviceIds?: string[];
        capability?: string;
        value?: any;
        zone?: string;
        action?: string;
        /** ID of the voice assistant device that should execute this job */
        voiceAssistantDeviceId?: string;
    };
    
    /** Repeat configuration */
    repeat: {
        /** Is this a one-time job or repeating? */
        isRepeating: boolean;
        /** For repeating jobs: 'daily', 'weekly', 'monthly', or cron-like pattern */
        pattern?: string;
        /** Days of week for weekly repeats (0=Sunday, 6=Saturday) */
        daysOfWeek?: number[];
        /** End date for repeating jobs (optional) */
        endDate?: Date;
    };
    
    /** Should the agent provide feedback when completed? */
    output: {
        /** Should provide feedback? */
        shouldNotify: boolean;
        /** Custom message to say/display when completed (optional) */
        message?: string;
        /** Type of output: 'voice', 'text', 'silent' */
        type: 'voice' | 'text' | 'silent';
    };
    
    /** Which agent/session created this job */
    sender: {
        /** Agent identifier */
        agentId: string;
        /** Session identifier for callback */
        sessionId?: string;
        /** User identifier */
        userId?: string;
    };
    
    /** Job metadata */
    metadata: {
        /** When the job was created */
        createdAt: Date;
        /** Current status */
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
        /** Number of execution attempts */
        attempts: number;
        /** Last execution time */
        lastExecuted?: Date;
        /** Next execution time (for repeating jobs) */
        nextExecution?: Date;
        /** Error message if failed */
        lastError?: string;
    };
}

type JobManagerEvents = {
    jobAdded: (job: ScheduledJob) => void;
    jobUpdated: (job: ScheduledJob) => void;
    jobDeleted: (jobId: string) => void;
    jobExecuted: (job: ScheduledJob, result: any) => void;
    jobFailed: (job: ScheduledJob, error: any) => void;
};

export { JobManagerEvents };

export class JobManager extends (EventEmitter as new () => TypedEmitter<JobManagerEvents>) {
    private jobs: Map<string, ScheduledJob> = new Map();
    private logger = createLogger('JobManager', true);
    private geoHelper: GeoHelper;
    private homey: any;
    private readonly STORAGE_KEY = 'scheduled_jobs';
    
    constructor(geoHelper: GeoHelper, homey: any) {
        super();
        this.geoHelper = geoHelper;
        this.homey = homey;
        this.logger.info('JobManager initialized');
        
        // Load existing jobs from storage
        this.loadJobsFromStorage();
        
        // Listen for settings changes (external modifications)
        this.homey.settings.on('set', this.onSettingsChanged.bind(this));
    }

    /**
     * Create a new scheduled job
     */
    createJob(jobData: {
        scheduledTime: Date;
        instruction: string;
        parsedDetails?: ScheduledJob['parsedDetails'];
        repeat?: Partial<ScheduledJob['repeat']>;
        output?: Partial<ScheduledJob['output']>;
        sender: ScheduledJob['sender'];
    }): ScheduledJob {
        const jobId = this.generateJobId();
        
        const job: ScheduledJob = {
            id: jobId,
            scheduledTime: jobData.scheduledTime,
            instruction: jobData.instruction,
            parsedDetails: jobData.parsedDetails,
            repeat: {
                isRepeating: jobData.repeat?.isRepeating || false,
                pattern: jobData.repeat?.pattern,
                daysOfWeek: jobData.repeat?.daysOfWeek,
                endDate: jobData.repeat?.endDate
            },
            output: {
                shouldNotify: jobData.output?.shouldNotify ?? true,
                message: jobData.output?.message,
                type: jobData.output?.type || 'voice'
            },
            sender: jobData.sender,
            metadata: {
                createdAt: new Date(),
                status: 'pending',
                attempts: 0,
                nextExecution: (jobData.repeat?.isRepeating && jobData.repeat) 
                    ? this.calculateNextExecution(jobData.scheduledTime, { 
                        isRepeating: true, 
                        ...jobData.repeat 
                    }) || undefined
                    : undefined
            }
        };

        this.jobs.set(jobId, job);
        this.logger.info(`Created job ${jobId}: "${jobData.instruction}" scheduled for ${jobData.scheduledTime.toISOString()}`);
        this.emit('jobAdded', job);
        
        // Persist to storage
        this.saveJobsToStorage();
        
        return job;
    }

    /**
     * Get all jobs
     */
    getAllJobs(): ScheduledJob[] {
        return Array.from(this.jobs.values());
    }

    /**
     * Get jobs by status
     */
    getJobsByStatus(status: ScheduledJob['metadata']['status']): ScheduledJob[] {
        return this.getAllJobs().filter(job => job.metadata.status === status);
    }

    /**
     * Get jobs by sender/agent
     */
    getJobsBySender(agentId: string, sessionId?: string): ScheduledJob[] {
        return this.getAllJobs().filter(job => 
            job.sender.agentId === agentId && 
            (!sessionId || job.sender.sessionId === sessionId)
        );
    }

    /**
     * Get a specific job by ID
     */
    getJob(jobId: string): ScheduledJob | undefined {
        return this.jobs.get(jobId);
    }

    /**
     * Update a job
     */
    updateJob(jobId: string, updates: Partial<ScheduledJob>): boolean {
        const job = this.jobs.get(jobId);
        if (!job) {
            this.logger.warn(`Attempted to update non-existent job: ${jobId}`);
            return false;
        }

        const updatedJob = { ...job, ...updates };
        
        // Update next execution time if repeat settings changed
        if (updates.repeat || updates.scheduledTime) {
            const nextExecution = updatedJob.repeat.isRepeating 
                ? this.calculateNextExecution(updatedJob.scheduledTime, updatedJob.repeat)
                : null;
            updatedJob.metadata.nextExecution = nextExecution || undefined;
        }

        this.jobs.set(jobId, updatedJob);
        this.logger.info(`Updated job ${jobId}`);
        this.emit('jobUpdated', updatedJob);
        
        // Persist to storage
        this.saveJobsToStorage();
        
        return true;
    }

    /**
     * Delete a job
     */
    deleteJob(jobId: string): boolean {
        const job = this.jobs.get(jobId);
        if (!job) {
            this.logger.warn(`Attempted to delete non-existent job: ${jobId}`);
            return false;
        }

        this.jobs.delete(jobId);
        this.logger.info(`Deleted job ${jobId}: "${job.instruction}"`);
        this.emit('jobDeleted', jobId);
        
        // Persist to storage
        this.saveJobsToStorage();
        
        return true;
    }

    /**
     * Mark a job as completed
     */
    markJobCompleted(jobId: string, result?: any): boolean {
        const job = this.jobs.get(jobId);
        if (!job) return false;

        job.metadata.status = 'completed';
        job.metadata.lastExecuted = new Date();
        
        // If it's a repeating job, schedule the next execution
        if (job.repeat.isRepeating) {
            const nextTime = this.calculateNextExecution(job.scheduledTime, job.repeat);
            if (nextTime && (!job.repeat.endDate || nextTime <= job.repeat.endDate)) {
                job.scheduledTime = nextTime;
                job.metadata.status = 'pending';
                const nextExecution = this.calculateNextExecution(nextTime, job.repeat);
                job.metadata.nextExecution = nextExecution || undefined;
            } else {
                // Repeating job has ended
                job.metadata.status = 'completed';
                job.metadata.nextExecution = undefined;
            }
        }

        this.jobs.set(jobId, job);
        this.emit('jobExecuted', job, result);
        
        // Persist to storage
        this.saveJobsToStorage();
        
        return true;
    }

    /**
     * Mark a job as failed
     */
    markJobFailed(jobId: string, error: any): boolean {
        const job = this.jobs.get(jobId);
        if (!job) return false;

        job.metadata.status = 'failed';
        job.metadata.attempts += 1;
        job.metadata.lastError = error?.message || String(error);
        job.metadata.lastExecuted = new Date();

        this.jobs.set(jobId, job);
        this.logger.error(`Job ${jobId} failed: ${job.metadata.lastError}`);
        this.emit('jobFailed', job, error);
        
        // Persist to storage
        this.saveJobsToStorage();
        
        return true;
    }

    /**
     * Get jobs that should be executed now
     */
    getJobsDueForExecution(currentTime: Date = new Date()): ScheduledJob[] {
        return this.getJobsByStatus('pending').filter(job => 
            job.scheduledTime <= currentTime
        );
    }

    /**
     * Parse natural language time expressions into Date objects
     */
    parseTimeExpression(expression: string, currentTime: Date = new Date()): Date | null {
        const timezone = this.geoHelper.timezone || "Europe/Oslo";
        
        try {
            // Handle "in X hours/minutes" 
            const relativeMatch = expression.match(/in (\d+)\s*(hour|hours|minute|minutes|min)/i);
            if (relativeMatch) {
                const amount = parseInt(relativeMatch[1]);
                const unit = relativeMatch[2].toLowerCase();
                const milliseconds = unit.startsWith('hour') ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
                return new Date(currentTime.getTime() + milliseconds);
            }

            // Handle "tomorrow at X"
            const tomorrowMatch = expression.match(/tomorrow at (\d+):?(\d*)\s*(am|pm)?/i);
            if (tomorrowMatch) {
                const hour = parseInt(tomorrowMatch[1]);
                const minute = parseInt(tomorrowMatch[2] || '0');
                const ampm = tomorrowMatch[3]?.toLowerCase();
                
                let adjustedHour = hour;
                if (ampm === 'pm' && hour < 12) adjustedHour += 12;
                if (ampm === 'am' && hour === 12) adjustedHour = 0;
                
                const tomorrow = new Date(currentTime);
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(adjustedHour, minute, 0, 0);
                return tomorrow;
            }

            // Handle "at X:XX" (today)
            const todayTimeMatch = expression.match(/at (\d+):?(\d*)\s*(am|pm)?/i);
            if (todayTimeMatch) {
                const hour = parseInt(todayTimeMatch[1]);
                const minute = parseInt(todayTimeMatch[2] || '0');
                const ampm = todayTimeMatch[3]?.toLowerCase();
                
                let adjustedHour = hour;
                if (ampm === 'pm' && hour < 12) adjustedHour += 12;
                if (ampm === 'am' && hour === 12) adjustedHour = 0;
                
                const today = new Date(currentTime);
                today.setHours(adjustedHour, minute, 0, 0);
                
                // If the time has already passed today, schedule for tomorrow
                if (today <= currentTime) {
                    today.setDate(today.getDate() + 1);
                }
                
                return today;
            }

            // Handle "each workday" pattern
            if (expression.includes('workday') || expression.includes('weekday')) {
                return null; // Will be handled by repeat logic
            }

            this.logger.warn(`Could not parse time expression: "${expression}"`);
            return null;
            
        } catch (error: any) {
            this.logger.error(`Error parsing time expression "${expression}":`, error);
            return null;
        }
    }

    /**
     * Calculate next execution time for repeating jobs
     */
    private calculateNextExecution(baseTime: Date, repeatConfig: ScheduledJob['repeat']): Date | null {
        if (!repeatConfig.isRepeating) return null;

        const next = new Date(baseTime);

        switch (repeatConfig.pattern) {
            case 'daily':
                next.setDate(next.getDate() + 1);
                return next;

            case 'weekly':
                next.setDate(next.getDate() + 7);
                return next;

            case 'weekdays':
                // Skip to next weekday (Monday-Friday)
                do {
                    next.setDate(next.getDate() + 1);
                } while (next.getDay() === 0 || next.getDay() === 6); // Skip Sunday(0) and Saturday(6)
                return next;

            default:
                if (repeatConfig.daysOfWeek && repeatConfig.daysOfWeek.length > 0) {
                    // Find next day that matches the specified days of week
                    const currentDay = next.getDay();
                    const validDays = [...repeatConfig.daysOfWeek].sort();
                    
                    // Find next valid day
                    let nextDay = validDays.find(day => day > currentDay);
                    if (nextDay === undefined) {
                        // Wrap to next week
                        nextDay = validDays[0];
                        const daysToAdd = (7 - currentDay) + nextDay;
                        next.setDate(next.getDate() + daysToAdd);
                    } else {
                        next.setDate(next.getDate() + (nextDay - currentDay));
                    }
                    return next;
                }
        }

        return null;
    }

    /**
     * Generate a unique job ID
     */
    private generateJobId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substr(2, 5);
        return `job_${timestamp}_${random}`;
    }

    /**
     * Get job statistics
     */
    getJobStats(): {
        total: number;
        pending: number;
        running: number;
        completed: number;
        failed: number;
        cancelled: number;
    } {
        const jobs = this.getAllJobs();
        return {
            total: jobs.length,
            pending: jobs.filter(j => j.metadata.status === 'pending').length,
            running: jobs.filter(j => j.metadata.status === 'running').length,
            completed: jobs.filter(j => j.metadata.status === 'completed').length,
            failed: jobs.filter(j => j.metadata.status === 'failed').length,
            cancelled: jobs.filter(j => j.metadata.status === 'cancelled').length,
        };
    }

    /**
     * Load jobs from Homey settings storage
     */
    private loadJobsFromStorage(): void {
        try {
            const storedJobs = this.homey.settings.get(this.STORAGE_KEY);
            
            if (!storedJobs || !Array.isArray(storedJobs)) {
                this.logger.info('No stored jobs found or invalid format, starting with empty job list');
                return;
            }

            let loadedCount = 0;
            let skippedCount = 0;

            for (const jobData of storedJobs) {
                try {
                    // Deserialize the job data, converting date strings back to Date objects
                    const job: ScheduledJob = {
                        ...jobData,
                        scheduledTime: new Date(jobData.scheduledTime),
                        repeat: {
                            ...jobData.repeat,
                            endDate: jobData.repeat.endDate ? new Date(jobData.repeat.endDate) : undefined
                        },
                        metadata: {
                            ...jobData.metadata,
                            createdAt: new Date(jobData.metadata.createdAt),
                            lastExecuted: jobData.metadata.lastExecuted ? new Date(jobData.metadata.lastExecuted) : undefined,
                            nextExecution: jobData.metadata.nextExecution ? new Date(jobData.metadata.nextExecution) : undefined
                        }
                    };

                    // Validate that the job has required fields
                    if (job.id && job.instruction && job.scheduledTime && job.sender) {
                        this.jobs.set(job.id, job);
                        loadedCount++;
                    } else {
                        this.logger.warn(`Skipping invalid job data: missing required fields`, jobData);
                        skippedCount++;
                    }
                } catch (jobError: any) {
                    this.logger.error(`Failed to deserialize job: ${jobError.message}`, jobData);
                    skippedCount++;
                }
            }

            this.logger.info(`Loaded ${loadedCount} jobs from storage${skippedCount > 0 ? `, skipped ${skippedCount} invalid jobs` : ''}`);
            
        } catch (error: any) {
            this.logger.error('Failed to load jobs from storage:', error);
            // Continue with empty job list rather than crashing
        }
    }

    /**
     * Save all jobs to Homey settings storage
     */
    private saveJobsToStorage(): void {
        try {
            const jobsArray = Array.from(this.jobs.values()).map(job => ({
                ...job,
                // Convert Date objects to ISO strings for JSON serialization
                scheduledTime: job.scheduledTime.toISOString(),
                repeat: {
                    ...job.repeat,
                    endDate: job.repeat.endDate ? job.repeat.endDate.toISOString() : undefined
                },
                metadata: {
                    ...job.metadata,
                    createdAt: job.metadata.createdAt.toISOString(),
                    lastExecuted: job.metadata.lastExecuted ? job.metadata.lastExecuted.toISOString() : undefined,
                    nextExecution: job.metadata.nextExecution ? job.metadata.nextExecution.toISOString() : undefined
                }
            }));

            this.homey.settings.set(this.STORAGE_KEY, jobsArray);
            this.logger.info(`Saved ${jobsArray.length} jobs to storage`);
            
        } catch (error: any) {
            this.logger.error('Failed to save jobs to storage:', error);
        }
    }

    /**
     * Handle settings changes from external sources
     */
    private onSettingsChanged(key: string): void {
        if (key === this.STORAGE_KEY) {
            this.logger.info('Jobs were modified externally, reloading from storage');
            
            // Clear current jobs
            this.jobs.clear();
            
            // Reload from storage
            this.loadJobsFromStorage();
            
            // Emit event that jobs were reloaded
            this.emit('jobsReloaded' as any, this.getAllJobs());
        }
    }

    /**
     * Clear all jobs (useful for testing or reset)
     */
    clearAllJobs(): void {
        const jobCount = this.jobs.size;
        this.jobs.clear();
        this.saveJobsToStorage();
        this.logger.info(`Cleared all ${jobCount} jobs`);
    }

    /**
     * Export jobs to a JSON string (for backup purposes)
     */
    exportJobs(): string {
        try {
            const jobsArray = Array.from(this.jobs.values());
            return JSON.stringify(jobsArray, null, 2);
        } catch (error: any) {
            this.logger.error('Failed to export jobs:', error);
            throw new Error('Failed to export jobs: ' + error.message);
        }
    }

    /**
     * Import jobs from a JSON string (for restore purposes)
     */
    importJobs(jsonData: string, replaceExisting: boolean = false): { imported: number; skipped: number; errors: string[] } {
        try {
            const jobsData = JSON.parse(jsonData);
            
            if (!Array.isArray(jobsData)) {
                throw new Error('Invalid format: expected array of jobs');
            }

            if (replaceExisting) {
                this.jobs.clear();
            }

            let imported = 0;
            let skipped = 0;
            const errors: string[] = [];

            for (const jobData of jobsData) {
                try {
                    // Check if job already exists
                    if (this.jobs.has(jobData.id)) {
                        if (!replaceExisting) {
                            skipped++;
                            continue;
                        }
                    }

                    // Create job from data (this will also save to storage)
                    const job = this.createJob({
                        scheduledTime: new Date(jobData.scheduledTime),
                        instruction: jobData.instruction,
                        parsedDetails: jobData.parsedDetails,
                        repeat: jobData.repeat,
                        output: jobData.output,
                        sender: jobData.sender
                    });

                    imported++;
                    
                } catch (jobError: any) {
                    errors.push(`Job ${jobData.id || 'unknown'}: ${jobError.message}`);
                }
            }

            this.logger.info(`Import completed: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
            return { imported, skipped, errors };
            
        } catch (error: any) {
            this.logger.error('Failed to import jobs:', error);
            throw new Error('Failed to import jobs: ' + error.message);
        }
    }
}