# Release-signing public keys

One file per key: `<key-id>.pub` containing the base64 ed25519 public key (from
`sign-manifest keygen`). The private seed never enters the repo; it lives only in the
GitHub Actions secret `RELEASE_SIGNING_KEY`.

- The release workflow verifies every manifest against `<RELEASE_KEY_ID>.pub` here.
- From M8 the Server Agent embeds these files (`go:embed`) as its trusted keyring.
- Rotation: add the new key file, ship a release signed by the OLD key that contains the new
  key, then switch `RELEASE_KEY_ID`. Revocation: delete the file and ship a release.

No key yet: see PROGRESS.md "Waiting on Dwahnil".
