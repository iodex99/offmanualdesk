# Installer (WiX v4 MSI, first install only)

Built (ADR-071): `OffManual.wxs`, WiX Toolset v7.0.1 (Open Source Maintenance Fee EULA accepted on Dwahnil's
instruction; the sponsorship is due once Off Manual's revenue reaches US$10,000 a year). CI builds a test MSI and
installs/uninstalls it on windows-latest; the release workflow builds `OffManual-<version>.msi` from the signed
payload. Updates after the first install never use the MSI: the Server Agent stages signed releases side by side
(ADR-010/062).

The MSI: installs `versions\<v>\` and the `current` junction under `C:\Program Files\OffManual\`, runs `server-agent setup` (the `current` junction, optional enrolment
with `CONSOLEURL` + `ENROLCODE`, service registered through `current`), sets Desk autostart for all users (HKLM Run)
and the Explorer "Ask Off Manual" verb. Uninstall runs `server-agent teardown` first. Everything ships inside (ADR-072): the
payload carries Node, OpenClaw and the pinned Python with openpyxl/pandas; the MSI also carries Microsoft's WebView2
Evergreen Standalone Installer in `redist\`, which `setup` runs (after checking its Microsoft signature) only when
WebView2 is missing; Desk links the C runtime statically, so no Visual C++ Redistributable is needed. Not yet:
Authenticode-signing the MSI itself.
