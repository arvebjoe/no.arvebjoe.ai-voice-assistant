import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobExecutor } from '../src/helpers/job-executor.mjs';
import { JobManager } from '../src/helpers/job-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';

describe('JobExecutor Integration Tests', () => {
    let jobExecutor: JobExecutor;
    let jobManager: JobManager;
    let mockHomey: MockHomey;
    let mockDeviceManager: MockDeviceManager;
    let mockGeoHelper: MockGeoHelper;

    beforeEach(() => {
        mockHomey = new MockHomey();
        mockDeviceManager = new MockDeviceManager();
        mockGeoHelper = new MockGeoHelper();
        
        jobManager = new JobManager(mockGeoHelper as any, mockHomey);
        jobExecutor = new JobExecutor(jobManager, mockDeviceManager as any, mockHomey);
    });

    afterEach(() => {
        jobExecutor.stop();
    });

    it('should initialize successfully', () => {
        expect(jobExecutor).toBeDefined();
        expect(jobExecutor.getStatus().isRunning).toBe(false);
    });

    it('should start and stop correctly', () => {
        jobExecutor.start();
        expect(jobExecutor.getStatus().isRunning).toBe(true);
        
        jobExecutor.stop();
        expect(jobExecutor.getStatus().isRunning).toBe(false);
    });

    it('should get status information', () => {
        const status = jobExecutor.getStatus();
        
        expect(status).toHaveProperty('isRunning');
        expect(status).toHaveProperty('checkInterval');
        expect(status).toHaveProperty('availableDevices');
        expect(status).toHaveProperty('currentlyExecuting');
        expect(status.checkInterval).toBe(30000); // 30 seconds default
        expect(status.currentlyExecuting).toBe(0);
    });

    it('should find available devices through homey driver system', () => {
        // Mock the homey drivers system
        const mockDevice = {
            getData: () => ({ id: 'test-device-1' }),
            speakText: async (text: string) => {
                console.log(`Mock device speaking: ${text}`);
            },
            currentZone: 'Living Room'
        };

        const mockDriver = {
            getDevices: () => [mockDevice]
        };

        // Add drivers property to mockHomey
        (mockHomey as any).drivers = {
            getDrivers: () => ({
                'home-assistant-voice-preview-edition': mockDriver
            })
        };

        const availableDevices = jobExecutor.getAvailableDevices();
        expect(availableDevices).toHaveLength(1);
        expect(availableDevices[0].id).toBe('test-device-1');
        expect(availableDevices[0].zone).toBe('Living Room');
    });

    it('should create and handle basic job execution lifecycle', () => {
        // Create a job scheduled for immediate execution
        const now = new Date();
        const job = jobManager.createJob({
            scheduledTime: now,
            instruction: 'Turn on the living room lights',
            output: {
                shouldNotify: false,
                type: 'silent'
            },
            sender: {
                agentId: 'test-agent',
                sessionId: 'test-session'
            }
        });

        expect(job).toBeTruthy();
        expect(job.instruction).toBe('Turn on the living room lights');
        expect(job.metadata.status).toBe('pending');
        
        // Check that JobExecutor can find due jobs
        const dueJobs = jobManager.getJobsDueForExecution();
        expect(dueJobs.length).toBeGreaterThan(0);
        expect(dueJobs[0].instruction).toBe('Turn on the living room lights');
    });
});