# Changelog

## 1.0.16

- Skip overlapping polls when a previous API request is still in flight.
- Refresh Cognito credentials about 60 seconds before JWT expiry (not only after 401).
- Mark Ting sensors offline via HomeKit `StatusActive` / `StatusFault` after consecutive poll failures; recover when the API responds again.
- Use `StatusFault` only for API connectivity, not for active hazard states (hazard remains on smoke/contact characteristics).

## 1.0.15

- Normalize Ting Wi-Fi MAC addresses before storing them in Homebridge status data.

