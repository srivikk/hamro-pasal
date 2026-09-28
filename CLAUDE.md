# Agent Instructions for Hamro Pasal

1. Source of Truth: Follow SPEC.md strictly. Never assume default configurations.
2. Scope Discipline: Implement ONLY the specific task or module requested in each prompt. Do not scaffold unrequested features.
3. Code Quality: Strict TypeScript (`strict: true`, zero `any` types).
4. Testing Standard: Write unit or integration tests for every service, transaction, and state mutation before declaring a task complete.
5. Local Realities: Never replace Nepal address models (Ward/Palika) or payment flows (eSewa HMAC Base64/Khalti) with Western defaults.