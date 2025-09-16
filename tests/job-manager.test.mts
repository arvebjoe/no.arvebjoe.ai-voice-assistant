import { describe, it, expect, beforeEach } from 'vitest';
import { JobManager } from '../src/helpers/job-manager.mjs';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

describe('JobManager Integration Tests', () => {
    let mockHomey: MockHomey;
    let mockDeviceManager: MockDeviceManager;
    let mockGeoHelper: MockGeoHelper;
    let mockWeatherHelper: MockWeatherHelper;
    let jobManager: JobManager;
    let toolManager: ToolManager;

    beforeEach(async () => {
        // Reset settings manager
        settingsManager.reset();
        
        // Create fresh mock instances
        mockHomey = new MockHomey();
        mockDeviceManager = new MockDeviceManager();
        mockGeoHelper = new MockGeoHelper();
        mockWeatherHelper = new MockWeatherHelper();
        
        // Initialize mocks
        await mockDeviceManager.init();
        await mockDeviceManager.fetchData();
        await mockGeoHelper.init();
        await mockWeatherHelper.init();
        
        // Initialize settings manager
        settingsManager.init(mockHomey);
        
        // Create JobManager and ToolManager
        jobManager = new JobManager(mockGeoHelper as any);
        toolManager = new ToolManager(mockHomey, 'Office', mockDeviceManager as any, mockGeoHelper as any, mockWeatherHelper as any, jobManager);
    });

    it('should create a scheduled job using the tool', async () => {
        const handlers = toolManager.getToolHandlers();
        const createJobHandler = handlers['create_scheduled_job'];
        
        expect(createJobHandler).toBeDefined();

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);

        const result = await createJobHandler({
            scheduledTime: tomorrow.toISOString(),
            instruction: "Turn on the living room lights",
            parsedDetails: {
                deviceIds: ["device_1", "device_2"],
                capability: "onoff",
                value: true,
                zone: "Living Room",
                action: "turn_on"
            },
            repeat: {
                isRepeating: false
            },
            output: {
                shouldNotify: true,
                message: "Good morning! I've turned on your lights.",
                type: "voice"
            },
            sender: {
                agentId: "test_agent",
                sessionId: "test_session",
                userId: "test_user"
            }
        });

        expect(result.ok).toBe(true);
        expect(result.data.jobId).toBeDefined();
        expect(result.data.instruction).toBe("Turn on the living room lights");
        expect(result.data.isRepeating).toBe(false);
        expect(result.data.status).toBe("pending");
    });

    it('should list scheduled jobs', async () => {
        // First create a job
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(8, 30, 0, 0);

        const job = jobManager.createJob({
            scheduledTime: tomorrow,
            instruction: "Set thermostat to 22 degrees",
            sender: {
                agentId: "test_agent"
            }
        });

        const handlers = toolManager.getToolHandlers();
        const listJobsHandler = handlers['list_scheduled_jobs'];
        
        const result = await listJobsHandler({});

        expect(result.ok).toBe(true);
        expect(result.data.count).toBe(1);
        expect(result.data.jobs).toHaveLength(1);
        expect(result.data.jobs[0].instruction).toBe("Set thermostat to 22 degrees");
        expect(result.data.jobs[0].status).toBe("pending");
    });

    it('should delete a scheduled job', async () => {
        // Create a job first
        const job = jobManager.createJob({
            scheduledTime: new Date(Date.now() + 60000), // 1 minute from now
            instruction: "Test job for deletion",
            sender: {
                agentId: "test_agent"
            }
        });

        const handlers = toolManager.getToolHandlers();
        const deleteJobHandler = handlers['delete_scheduled_job'];
        
        const result = await deleteJobHandler({
            jobId: job.id
        });

        expect(result.ok).toBe(true);
        expect(result.data.message).toContain(job.id);
        
        // Verify job is deleted
        const jobs = jobManager.getAllJobs();
        expect(jobs).toHaveLength(0);
    });

    it('should parse time expressions', async () => {
        const handlers = toolManager.getToolHandlers();
        const parseTimeHandler = handlers['parse_schedule_time'];

        // Test "in 1 hour"
        const result1 = await parseTimeHandler({
            timeExpression: "in 1 hour"
        });

        expect(result1.ok).toBe(true);
        expect(result1.data.isValid).toBe(true);
        expect(result1.data.originalExpression).toBe("in 1 hour");
        
        const parsedTime = new Date(result1.data.parsedDateTime);
        const expectedTime = new Date(Date.now() + 60 * 60 * 1000);
        
        // Allow for small time differences due to execution time
        expect(Math.abs(parsedTime.getTime() - expectedTime.getTime())).toBeLessThan(1000);

        // Test "tomorrow at 7:00"
        const result2 = await parseTimeHandler({
            timeExpression: "tomorrow at 7:00"
        });

        expect(result2.ok).toBe(true);
        expect(result2.data.isValid).toBe(true);
        
        const tomorrowParsed = new Date(result2.data.parsedDateTime);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(7, 0, 0, 0);
        
        expect(tomorrowParsed.getHours()).toBe(7);
        expect(tomorrowParsed.getMinutes()).toBe(0);
    });

    it('should get job statistics', async () => {
        // Create some test jobs
        jobManager.createJob({
            scheduledTime: new Date(Date.now() + 60000),
            instruction: "Job 1",
            sender: { agentId: "test" }
        });
        
        jobManager.createJob({
            scheduledTime: new Date(Date.now() + 120000),
            instruction: "Job 2", 
            sender: { agentId: "test" }
        });

        const handlers = toolManager.getToolHandlers();
        const statsHandler = handlers['get_job_stats'];
        
        const result = await statsHandler({});

        expect(result.ok).toBe(true);
        expect(result.data.total).toBe(2);
        expect(result.data.pending).toBe(2);
        expect(result.data.completed).toBe(0);
        expect(result.data.failed).toBe(0);
    });

    it('should handle repeating job creation', async () => {
        const handlers = toolManager.getToolHandlers();
        const createJobHandler = handlers['create_scheduled_job'];

        const monday = new Date();
        monday.setHours(6, 30, 0, 0);

        const result = await createJobHandler({
            scheduledTime: monday.toISOString(),
            instruction: "Wake me up - it's a work day!",
            repeat: {
                isRepeating: true,
                pattern: "weekdays",
                daysOfWeek: [1, 2, 3, 4, 5] // Monday to Friday
            },
            output: {
                shouldNotify: true,
                message: "Good morning! Time to get up for work.",
                type: "voice"
            },
            sender: {
                agentId: "alarm_agent",
                sessionId: "wake_up_call"
            }
        });

        expect(result.ok).toBe(true);
        expect(result.data.isRepeating).toBe(true);
        
        // Check that the job was created correctly
        const job = jobManager.getJob(result.data.jobId);
        expect(job?.repeat.isRepeating).toBe(true);
        expect(job?.repeat.pattern).toBe("weekdays");
        expect(job?.repeat.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it('should get detailed job information', async () => {
        // Create a complex job
        const scheduledTime = new Date();
        scheduledTime.setHours(scheduledTime.getHours() + 2);

        const job = jobManager.createJob({
            scheduledTime,
            instruction: "Turn off office lights and lock the door",
            parsedDetails: {
                deviceIds: ["office_light_1", "office_light_2", "office_door_lock"],
                zone: "Office",
                action: "secure_office"
            },
            output: {
                shouldNotify: true,
                message: "Office has been secured for the night.",
                type: "text"
            },
            sender: {
                agentId: "security_agent",
                sessionId: "evening_routine",
                userId: "john_doe"
            }
        });

        const handlers = toolManager.getToolHandlers();
        const getDetailsHandler = handlers['get_job_details'];
        
        const result = await getDetailsHandler({
            jobId: job.id
        });

        expect(result.ok).toBe(true);
        expect(result.data.instruction).toBe("Turn off office lights and lock the door");
        expect(result.data.parsedDetails.deviceIds).toEqual(["office_light_1", "office_light_2", "office_door_lock"]);
        expect(result.data.parsedDetails.zone).toBe("Office");
        expect(result.data.parsedDetails.action).toBe("secure_office");
        expect(result.data.output.message).toBe("Office has been secured for the night.");
        expect(result.data.sender.agentId).toBe("security_agent");
    });

    it('should handle invalid job deletion gracefully', async () => {
        const handlers = toolManager.getToolHandlers();
        const deleteJobHandler = handlers['delete_scheduled_job'];
        
        const result = await deleteJobHandler({
            jobId: "non_existent_job_id"
        });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("JOB_NOT_FOUND");
        expect(result.error.message).toContain("non_existent_job_id");
    });

    it('should handle invalid time expressions gracefully', async () => {
        const handlers = toolManager.getToolHandlers();
        const parseTimeHandler = handlers['parse_schedule_time'];

        const result = await parseTimeHandler({
            timeExpression: "some random invalid time"
        });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("TIME_PARSE_FAILED");
        expect(result.error.message).toContain("Could not parse time expression");
    });
});