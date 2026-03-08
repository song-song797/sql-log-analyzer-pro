# Contributing

Thanks for contributing to this project.

## Development setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start services:

```bash
npm run server
npm run dev
```

## Pull request checklist

- Base branch: `main`
- Keep each PR focused on one change area
- Update docs when behavior or deployment changes
- Run checks before pushing:

```bash
npm run lint
npm run build
npm run test:parser
```

## Coding guidelines

- Follow existing code style and naming conventions
- Do not commit runtime data (`data/`, `uploads/`, local logs, secrets)
- Prefer small, reviewable commits with clear messages

## Reporting issues

When opening an issue, include:

- Expected behavior
- Actual behavior
- Steps to reproduce
- Relevant logs or screenshots
