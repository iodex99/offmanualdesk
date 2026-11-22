# Installer (WiX v4 MSI, first install only)

Arrives in M8 (docs/UPDATES.md §1 step 8, docs/ARCHITECTURE.md F1). Updates after the first install never use
the MSI: the Server Agent stages signed releases side by side (ADR-010).

The MSI will: install `versions\<v>\` and the `current` junction under `C:\Program Files\OffManual\`, register the
Server Agent service (LocalSystem), set Desk autostart for all users, run the WebView2 bootstrapper, and take the
enrolment code as an MSI property.
