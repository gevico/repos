const command = process.env.INPUT_COMMAND;
if (!['request', 'apply'].includes(command)) throw new Error('Automation command must be request or apply');
process.argv[2] = command;
await import('../../../automation/scripts/ci.mjs');
