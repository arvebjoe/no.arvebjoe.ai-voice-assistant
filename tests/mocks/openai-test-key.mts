// The OpenAI key for the real-API integration tests, from the environment:
//
//   OPENAI_API_KEY=sk-... npm test
//
// Deliberately NOT read from env.json: Homey bundles env.json into every
// built/published app, so a test key kept there shipped to every install.
// Without the variable the integration suites are reported as skipped.
export const OPENAI_TEST_KEY: string = process.env.OPENAI_API_KEY?.trim() ?? '';

export const hasOpenAiTestKey: boolean = OPENAI_TEST_KEY.length > 0;
