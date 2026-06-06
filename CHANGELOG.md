# Changelog

## 1.0.6

- Added the default Cloudflare telemetry endpoint.

## 1.0.5

- Added optional anonymous telemetry support with a Cloudflare Worker/D1
  dashboard scaffold.
- Added `telemetryEnabled` and `telemetryEndpointUrl` configuration fields.

## 1.0.4

- Include `CHANGELOG.md` in the published npm package.
- Add repository and homepage metadata for npm and Homebridge plugin pages.
- Add an explicit package file list so npm publishes only the intended plugin
  files.

## 1.0.3

- Added release notes to the README.
- Added brief descriptions for each configuration field, including optional
  child bridge settings.

## 1.0.2

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

## 1.0.1

- Added the npm lockfile for reproducible installs.

## 1.0.0

- Initial public release with Whisker sign-in, Ting status polling,
  conservative hazard mapping, and HomeKit smoke/contact/occupancy service
  exposure.
