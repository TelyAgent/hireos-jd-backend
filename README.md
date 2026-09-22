# HireOS JD Backend

This service owns the JD workflow boundary while Core Record owns the
authoritative Job and RoleDefinitionVersion records.

## Local development

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run start:dev
```

The service listens on `http://127.0.0.1:3005/api`.

## Current Phase

The first backend slice supports:

- creating a JD draft for an existing Core Record Job;
- creating a Core Record `RoleDefinitionVersion`;
- confirming a draft and its corresponding role version;
- keeping a local JD draft projection for future collaboration and approval work.

Current endpoints:

```text
POST /api/jobs/:jobId/drafts
POST /api/jobs/:jobId/drafts/:draftId/confirm
```

The request must include `Idempotency-Key`. The JD service never connects
directly to the Core Record database; it calls the Core Record API.

## Ownership boundary

```text
Core Record:
  Job
  RoleDefinitionVersion
  JobRequirementSnapshot

JD:
  JobDraft
  future ChangeProposal / Approval / JDVersion / Publication

Screening:
  matching, screening policy, evaluation, decision and handoff
```

`JobCriteriaPage.tsx` remains a Screening frontend experience. Its existing
Screening API contract can later be backed by a facade that reads the
Core/JD versions without changing the page.
