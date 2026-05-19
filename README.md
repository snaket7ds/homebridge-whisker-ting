# Homebridge Whisker Ting

Homebridge Whisker Ting exposes Whisker Labs Ting sensor status in Apple Home
through Homebridge. It focuses on conservative hazard visibility rather than
replacing the Ting app or Whisker Labs monitoring.

The plugin signs in with the same email and password used by the Ting app,
polls the unofficial Whisker API, and maps the available Ting flags into a small
set of HomeKit services.

## What It Does

- Shows electrical fire hazard state as a HomeKit smoke sensor.
- Shows Ting fire, utility fire, and power quality flags as HomeKit sensors.
- Shows Ting learning/calibration mode as an occupancy-style status sensor.
- Ignores EFH events marked `ReviewedNotFire` so reviewed non-fire events do not
  stay active in HomeKit.
- Keeps Matter and websocket voltage streaming out of scope for now.

## Exposed HomeKit Services

- `Ting Electrical Fire Alert` as a HomeKit smoke sensor. Ting's main electrical
  fire hazard signal. It becomes active when EFH level is above `0`, unless the
  event is marked `ReviewedNotFire`.
- `Ting Fire Alert` as a HomeKit contact sensor. Ting's broad device-level fire
  event flag from `isFire`.
- `Ting Power Quality Alert` as a HomeKit contact sensor. A site-level power quality
  problem. This is not necessarily a fire alert.
- `Ting Utility Fire Alert` as a HomeKit contact sensor. Ting's utility-side fire
  hazard signal. It becomes active when UFH level is above `0`.
- `Ting Learning Mode` as a HomeKit occupancy sensor. Ting is still learning
  your home's electrical baseline. This is calibration/status, not a hazard.

The mapping is intentionally conservative. Ting remains the authoritative
safety system; HomeKit is only a secondary visibility layer.

Hazard state is parsed from Whisker's EFH/UFH status levels. EFH entries marked
`ReviewedNotFire` are not exposed as active electrical fire hazards.

## Configuration

```json
{
  "platform": "WhiskerTing",
  "name": "Ting",
  "username": "YOUR_TING_EMAIL",
  "password": "YOUR_TING_PASSWORD",
  "pollInterval": 60,
  "_bridge": {
    "name": "Ting Bridge",
    "username": "XX:XX:XX:XX:XX:XX",
    "port": 52127
  }
}
```

Configuration fields:

- `platform`: Must be `WhiskerTing`. This tells Homebridge which platform
  plugin should load this config block.
- `name`: The accessory name shown by Homebridge and used as the default Ting
  accessory name in HomeKit.
- `username`: The email address used to sign in to the Ting app.
- `password`: The password used to sign in to the Ting app. Homebridge stores
  this in its config, so protect access to your Homebridge instance.
- `pollInterval`: How often, in seconds, the plugin checks Whisker for updated
  Ting status. The minimum is `30`; the default is `60`.
- `_bridge`: Optional Homebridge child bridge settings. Running this plugin as
  a child bridge isolates it from other plugins and lets it restart separately.
- `_bridge.name`: The child bridge name shown in Homebridge.
- `_bridge.username`: The child bridge MAC-style identifier. It must be unique
  across your Homebridge setup.
- `_bridge.port`: The network port used by the child bridge. It must not
  conflict with another Homebridge bridge or service.

Generate a random Homebridge child-bridge username/MAC address:

```bash
node -e "console.log([...crypto.getRandomValues(new Uint8Array(6))].map((b,i)=>((i===0?(b|2)&254:b).toString(16).padStart(2,'0').toUpperCase())).join(':'))"
```

## Project Files

- `README.md`: setup notes, HomeKit mapping, and safety limitations.
- `config.schema.json`: Homebridge UI schema for the plugin settings.
- `package.json`: npm package metadata, runtime requirements, and scripts.
- `LICENSE`: MIT license for this Homebridge plugin.
- `NOTICE`: attribution for upstream projects and API behavior references.
- `src/index.js`: Homebridge plugin registration entry point.
- `src/platform.js`: Homebridge platform implementation and accessory mapping.
- `src/settings.js`: plugin and platform identifiers.
- `src/whisker-client.js`: Whisker authentication, API polling, and response
  normalization.
- `test/whisker-client.test.js`: unit tests for the Whisker client and hazard
  parsing behavior.

## Validation

```bash
npm run lint
npm test
npm pack --dry-run
```

## Release Notes

### 1.0.3

- Added release notes to the README.
- Added brief descriptions for each configuration field, including optional
  child bridge settings.

### 1.0.2

- Renamed HomeKit services so Ting accessories are easier to identify in Apple
  Home:
  - `Ting Electrical Fire Alert`
  - `Ting Fire Alert`
  - `Ting Power Quality Alert`
  - `Ting Utility Fire Alert`
  - `Ting Learning Mode`
- Added HomeKit `ConfiguredName` updates in addition to `Name`, which helps
  Apple Home show the intended labels instead of generic labels such as
  `Contact Sensor`.
- Added cleanup for older cached service names so existing Homebridge installs
  can migrate to the clearer labels.

### 1.0.1

- Added the npm lockfile for reproducible installs.

### 1.0.0

- Initial public release with Whisker sign-in, Ting status polling, conservative
  hazard mapping, and HomeKit smoke/contact/occupancy service exposure.

## Notes

- This is not official Whisker Labs support.
- Whisker can change or block the private API at any time.
- MFA is not supported by this plugin.
- Matter and websocket voltage streaming are intentionally not included.
- Do not rely on HomeKit for life-safety alerting.

## Attribution

This Homebridge plugin is based on the community Whisker Ting work from
`ha-whisker-ting` and its related forks:

https://github.com/simplytoast1/ha-whisker-ting

Additional upstream references are listed in `NOTICE`.
