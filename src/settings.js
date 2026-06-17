import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const PLATFORM_NAME = 'WhiskerTing';
export const PLUGIN_NAME = 'homebridge-whisker-ting';
export const PLUGIN_VERSION = pkg.version;
