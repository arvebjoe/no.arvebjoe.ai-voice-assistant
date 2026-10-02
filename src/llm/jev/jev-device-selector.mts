import type { Device } from '../../helpers/interfaces.mjs';
import type { Question, RequestStat, ScoreAnswer, SystemOneRequest, TypeSafeClient } from './typesafe-client.mjs';

/**
 * Picks which Homey devices a smart-home command targets, using Jev.
 *
 * Jev does not generate a list of devices: it answers typed questions. So code
 * enumerates the candidates and asks, per device, three Score questions (how
 * clearly the command refers to it, whether it is in the targeted room, whether
 * it is the requested kind). Each is normalized to 0–1, averaged with weights,
 * and a device is selected when the average clears THRESHOLD and no veto
 * dimension is below VETO_FLOOR.
 *
 * Design and numbers come from the jev-test-001 prototype (100-device test
 * home, jev-1.13):
 *  - Each device travels INSIDE its own question. Putting all devices in state
 *    and pointing at `devices[57]` made Jev lose track past ~50 devices ("lock
 *    the front door" selected 33 of them).
 *  - The prototype's fourth "action" dimension (could the device do it) is not
 *    asked here: the caller already filtered candidates by capability in code,
 *    which is exact and saves a quarter of the tokens.
 *  - Requests are batched and run in parallel; ~20 devices per request stayed
 *    ~470 ms median and was less exposed to a single slow request than 10.
 */

export type JevCandidate = Pick<Device, 'id' | 'name' | 'zone' | 'zones' | 'type' | 'capabilities'>;

export interface DimensionScore {
    value: number;       // normalized 0–1
    confidence: number;
}

export interface RankedDevice {
    device: JevCandidate;
    scores: Record<DimensionKey, DimensionScore>;
    weighted: number;
    vetoedBy: DimensionKey[];
    selected: boolean;
}

export interface SelectionResult {
    selected: JevCandidate[];
    /** Every candidate, best first — the near misses let the LLM ask "did you mean…". */
    ranked: RankedDevice[];
    requests: number;
    /** Per request: wall time and whether a duplicate was sent for it. */
    requestStats: RequestStat[];
    inputTokens: number;
    elapsedMs: number;
}

type DimensionKey = 'clarity' | 'room' | 'type';

interface Dimension {
    key: DimensionKey;
    weight: number;
    veto: boolean;
    question: (device: object, sameRoom: object[]) => Question;
}

// Tuned in jev-test-001 (8/10 benchmark commands right on every run).
export const THRESHOLD = 0.7;
export const VETO_FLOOR = 0.3;
export const DEVICES_PER_REQUEST = 20;

// The model-facing view of a device: names only, no ids or current values —
// the capability VALUES are noise for "which device is meant".
function describe(device: JevCandidate): Record<string, unknown> {
    const described: Record<string, unknown> = {
        name: device.name,
        room: device.zone,
        type: device.type,
        capabilities: device.capabilities.map(c => c.split('=')[0]),
    };
    // zones[0] is the device's own zone; the rest are its parents
    // ("Kitchen" inside "Ground floor"), which "downstairs" should match.
    const parents = (device.zones ?? []).slice(1).filter(z => z && z !== device.zone);
    if (parents.length > 0) described.inside = parents;
    return described;
}

const brief = (device: JevCandidate) => ({ name: device.name, type: device.type });

const DIMENSIONS: Dimension[] = [
    {
        key: 'clarity',
        weight: 1,
        veto: false,
        question: (device, sameRoom) => ({
            type: 'score',
            // Without its roommates, a device can't tell that a singular command
            // such as "the ceiling light" fits a different device better. Only
            // roommates of the same type are listed (they are the ones that can
            // compete for "the light") — the full room list was most of the
            // ~84k tokens a 94-candidate command cost on a live Homey.
            instructions: sameRoom.length > 0 ? {
                question: 'How clearly does the smart home command in `command` refer to the device `device`? `similar_devices_in_room` lists the other devices of the same type in the same room. If the command asks for one specific device and one of those devices fits the description better, the command refers to `device` less clearly.',
                device,
                similar_devices_in_room: sameRoom,
            } : {
                question: 'How clearly does the smart home command in `command` refer to the device `device`? It is the only device of its type in its room.',
                device,
            },
            criteria: [
                'The command does not refer to this device at all',
                'The command could only include this device by a loose or unlikely reading',
                'The command plausibly refers to this device through a general description, such as its kind and location',
                'The command explicitly names or uniquely identifies this device',
            ],
        }),
    },
    {
        key: 'room',
        weight: 1,
        veto: true,
        question: (device) => ({
            type: 'score',
            // "In the house" was read literally in the prototype (backyard lights
            // skipped), so spell out what a whole-home command covers.
            instructions: {
                question: 'Is the device `device` located in the room or area targeted by the smart home command in `command`? When the command names no room or area, the targeted room is `speaker_room`, the room the user is speaking in. A command for everywhere, all rooms, or the whole house targets every room and area, indoors and outdoors.',
                device,
            },
            criteria: [
                'The device is in a different room or area from the one the command targets',
                "The device's location only partly overlaps the targeted area",
                'The device is in the room or area the command targets, including when the command targets the whole home',
            ],
        }),
    },
    {
        key: 'type',
        weight: 1,
        veto: true,
        question: (device) => ({
            type: 'score',
            instructions: {
                question: 'Is the device `device` the kind of device the smart home command in `command` asks to control? Use its type, name and capabilities; for example, a socket powering a lamp counts as a light.',
                device,
            },
            criteria: [
                'The device is an unrelated kind of device',
                'The device is a related but different kind of device than the one requested',
                'The device is exactly the kind of device the command asks to control',
            ],
        }),
    },
];

// Ids are only seen by code, never by the model.
const questionId = (i: number, dim: DimensionKey) => `d${i}__${dim}`;

export function buildRequests(
    command: string,
    speakerRoom: string,
    devices: JevCandidate[],
    perRequest: number = DEVICES_PER_REQUEST,
): SystemOneRequest[] {
    const state = { command, speaker_room: speakerRoom };
    const requests: SystemOneRequest[] = [];
    for (let start = 0; start < devices.length; start += perRequest) {
        const questions: Record<string, Question> = {};
        for (let i = start; i < Math.min(start + perRequest, devices.length); i++) {
            const device = devices[i];
            const sameRoom = devices.filter(d => d !== device && d.zone === device.zone && d.type === device.type).map(brief);
            const described = describe(device);
            for (const dim of DIMENSIONS) {
                questions[questionId(i, dim.key)] = dim.question(described, sameRoom);
            }
        }
        requests.push({ state, questions });
    }
    return requests;
}

/**
 * Ask Jev which of `devices` the command targets. `speakerRoom` is the
 * satellite's own zone — the default scope when the command names no room.
 */
export async function selectDevices(
    client: TypeSafeClient,
    command: string,
    speakerRoom: string,
    devices: JevCandidate[],
): Promise<SelectionResult> {
    if (devices.length === 0) {
        return { selected: [], ranked: [], requests: 0, requestStats: [], inputTokens: 0, elapsedMs: 0 };
    }
    const requests = buildRequests(command, speakerRoom, devices);
    const started = Date.now();
    const { responses, stats } = await client.systemOneBatch(requests);
    const elapsedMs = Date.now() - started;

    const answers = Object.assign({}, ...responses.map(r => r.answers));
    const totalWeight = DIMENSIONS.reduce((sum, d) => sum + d.weight, 0);

    const ranked = devices.map((device, i): RankedDevice => {
        const scores = {} as Record<DimensionKey, DimensionScore>;
        let weighted = 0;
        for (const dim of DIMENSIONS) {
            const answer = answers[questionId(i, dim.key)] as ScoreAnswer | undefined;
            // A missing answer counts as "no" rather than failing the whole turn.
            const maxLevel = answer ? Object.keys(answer.legend).length - 1 : 1;
            const value = answer && maxLevel > 0 ? answer.score / maxLevel : 0;
            scores[dim.key] = { value, confidence: answer?.confidence ?? 0 };
            weighted += value * dim.weight;
        }
        weighted /= totalWeight;
        const vetoedBy = DIMENSIONS.filter(d => d.veto && scores[d.key].value < VETO_FLOOR).map(d => d.key);
        return { device, scores, weighted, vetoedBy, selected: weighted >= THRESHOLD && vetoedBy.length === 0 };
    }).sort((a, b) => b.weighted - a.weighted);

    return {
        selected: ranked.filter(r => r.selected).map(r => r.device),
        ranked,
        requests: requests.length,
        requestStats: stats,
        inputTokens: responses.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0),
        elapsedMs,
    };
}
