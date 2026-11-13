# Changelog

## 0.3.0

- Add `/provider model` interactive editing for individual models, including provider/model selection, cancellation, and reset confirmation.
- Add persistent manual overrides for context length, supported thinking levels, and `text`/`image` input modalities.
- Add explicit `model show`, `model set contextWindow|thinking|input`, and `model reset` commands for automation.
- Apply manual overrides at runtime registration as well as model sync, so edits survive sync and restart.
- Allow explicit thinking mappings such as `xhigh=max` and disabling reasoning with `thinking none`.
- Re-fetch automatic metadata before resetting overrides; failed requests leave persisted settings unchanged.

## 0.2.3

- Support Devin/CPA thinking levels and input modality metadata.
- Fill sparse Cognition SWE and Claude 5.5 model metadata.
- Apply provider model overrides after sync enrichment.
