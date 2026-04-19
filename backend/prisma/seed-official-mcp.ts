/**
 * Seed script for Official Anthropic MCP Servers, Plugins, and Skills
 *
 * Run with: npx tsx prisma/seed-official-mcp.ts
 *
 * Sources:
 * - https://github.com/modelcontextprotocol/servers
 * - https://github.com/anthropics/claude-plugins-official
 * - https://github.com/anthropics/knowledge-work-plugins
 * - https://github.com/anthropics/skills
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Load DATABASE_URL from environment or use default Docker Compose URL
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://super_agent:super_agent_dev@localhost:5432/super_agent';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// =============================================================================
// Official MCP Servers from modelcontextprotocol/servers
// =============================================================================

interface McpServerDef {
  name: string;
  description: string;
  hostAddress: string;
  config: {
    type: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
  category: string;
}

const OFFICIAL_MCP_SERVERS: McpServerDef[] = [
  // -------------------------------------------------------------------------
  // Core Reference Servers (from modelcontextprotocol/servers)
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-memory',
    description: 'Knowledge graph-based persistent memory system for maintaining context across conversations',
    hostAddress: 'npx -y @modelcontextprotocol/server-memory',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-filesystem',
    description: 'Secure file operations with configurable access controls for reading, writing, and managing files',
    hostAddress: 'npx -y @modelcontextprotocol/server-filesystem /path/to/workspace',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/workspace'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-git',
    description: 'Read, search, and manipulate Git repositories - clone, diff, log, branch operations',
    hostAddress: 'npx -y @modelcontextprotocol/server-git',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-fetch',
    description: 'Web content fetching and conversion optimized for LLM consumption',
    hostAddress: 'npx -y @modelcontextprotocol/server-fetch',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-sequential-thinking',
    description: 'Dynamic problem-solving through structured thought sequences for complex reasoning',
    hostAddress: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-time',
    description: 'Time and timezone conversion utilities',
    hostAddress: 'npx -y @modelcontextprotocol/server-time',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-time'],
    },
    category: 'core',
  },
  {
    name: 'mcp-server-everything',
    description: 'Reference/test server demonstrating all MCP features - prompts, resources, and tools',
    hostAddress: 'npx -y @modelcontextprotocol/server-everything',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
    category: 'reference',
  },

  // -------------------------------------------------------------------------
  // Database Servers
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-postgres',
    description: 'PostgreSQL database operations - query, schema inspection, and data management',
    hostAddress: 'npx -y @modelcontextprotocol/server-postgres',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' },
    },
    category: 'database',
  },
  {
    name: 'mcp-server-sqlite',
    description: 'SQLite database operations for local data management',
    hostAddress: 'npx -y @modelcontextprotocol/server-sqlite',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '/path/to/database.db'],
    },
    category: 'database',
  },
  {
    name: 'mcp-server-redis',
    description: 'Redis cache and data structure operations',
    hostAddress: 'npx -y @modelcontextprotocol/server-redis',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-redis'],
      env: { REDIS_URL: 'redis://localhost:6379' },
    },
    category: 'database',
  },

  // -------------------------------------------------------------------------
  // Cloud & DevOps Servers
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-aws-kb-retrieval',
    description: 'AWS Knowledge Base retrieval for RAG applications',
    hostAddress: 'npx -y @modelcontextprotocol/server-aws-kb-retrieval',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
    },
    category: 'cloud',
  },
  {
    name: 'mcp-server-github',
    description: 'GitHub API integration - repos, issues, PRs, actions, and code search',
    hostAddress: 'npx -y @modelcontextprotocol/server-github',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '' },
    },
    category: 'devops',
  },
  {
    name: 'mcp-server-gitlab',
    description: 'GitLab API integration - projects, merge requests, pipelines',
    hostAddress: 'npx -y @modelcontextprotocol/server-gitlab',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env: { GITLAB_TOKEN: '' },
    },
    category: 'devops',
  },
  {
    name: 'mcp-server-sentry',
    description: 'Sentry error tracking and monitoring integration',
    hostAddress: 'npx -y @modelcontextprotocol/server-sentry',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sentry'],
      env: { SENTRY_AUTH_TOKEN: '' },
    },
    category: 'devops',
  },

  // -------------------------------------------------------------------------
  // Communication & Productivity Servers
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-slack',
    description: 'Slack workspace integration - channels, messages, users, and search',
    hostAddress: 'npx -y @modelcontextprotocol/server-slack',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    },
    category: 'communication',
  },
  {
    name: 'mcp-server-google-drive',
    description: 'Google Drive file operations and search',
    hostAddress: 'npx -y @modelcontextprotocol/server-gdrive',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gdrive'],
    },
    category: 'productivity',
  },
  {
    name: 'mcp-server-google-maps',
    description: 'Google Maps API for location, directions, and places',
    hostAddress: 'npx -y @modelcontextprotocol/server-google-maps',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-google-maps'],
      env: { GOOGLE_MAPS_API_KEY: '' },
    },
    category: 'productivity',
  },

  // -------------------------------------------------------------------------
  // Browser & Web Automation
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-puppeteer',
    description: 'Browser automation with Puppeteer - screenshots, scraping, testing',
    hostAddress: 'npx -y @modelcontextprotocol/server-puppeteer',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    },
    category: 'browser',
  },
  {
    name: 'mcp-server-brave-search',
    description: 'Brave Search API for web and news search',
    hostAddress: 'npx -y @modelcontextprotocol/server-brave-search',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: '' },
    },
    category: 'search',
  },

  // -------------------------------------------------------------------------
  // Development Tools - Language Specific
  // -------------------------------------------------------------------------
  {
    name: 'mcp-server-typescript',
    description: 'TypeScript language server - type checking, refactoring, and code navigation',
    hostAddress: 'npx -y @anthropic/mcp-server-typescript',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-server-typescript'],
    },
    category: 'language',
  },
  {
    name: 'mcp-server-python',
    description: 'Python language tools - linting, formatting, type checking with pyright',
    hostAddress: 'uvx mcp-server-python',
    config: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-python'],
    },
    category: 'language',
  },
  {
    name: 'mcp-server-eslint',
    description: 'ESLint integration for JavaScript/TypeScript linting and auto-fix',
    hostAddress: 'npx -y @anthropic/mcp-server-eslint',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-server-eslint'],
    },
    category: 'language',
  },
  {
    name: 'mcp-server-prettier',
    description: 'Prettier code formatting for multiple languages',
    hostAddress: 'npx -y @anthropic/mcp-server-prettier',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/mcp-server-prettier'],
    },
    category: 'language',
  },
];

// =============================================================================
// Official Plugins from anthropics/claude-plugins-official
// =============================================================================

interface PluginDef {
  name: string;
  description: string;
  gitUrl: string;
  ref: string;
  category: string;
}

const OFFICIAL_PLUGINS: PluginDef[] = [
  // -------------------------------------------------------------------------
  // Knowledge Work Plugins
  // -------------------------------------------------------------------------
  {
    name: 'productivity-plugin',
    description: 'Tasks, calendars, workflows integration with Slack, Notion, Asana, Linear, Jira',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'productivity',
  },
  {
    name: 'sales-plugin',
    description: 'Prospect research, pipeline review with HubSpot, Close, Clay, ZoomInfo',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'sales',
  },
  {
    name: 'customer-support-plugin',
    description: 'Ticket triage, responses with Intercom, HubSpot, Guru',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'support',
  },
  {
    name: 'product-management-plugin',
    description: 'Specs, roadmaps with Linear, Figma, Amplitude, Pendo',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'product',
  },
  {
    name: 'marketing-plugin',
    description: 'Content, campaigns with Canva, Figma, HubSpot, Ahrefs',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'marketing',
  },
  {
    name: 'legal-plugin',
    description: 'Contract review, compliance with Box, Egnyte',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'legal',
  },
  {
    name: 'finance-plugin',
    description: 'Journal entries, reconciliation with Snowflake, Databricks, BigQuery',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'finance',
  },
  {
    name: 'data-plugin',
    description: 'SQL, dashboards, analysis with Snowflake, Databricks, Hex',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'data',
  },
  {
    name: 'enterprise-search-plugin',
    description: 'Cross-platform enterprise search',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'search',
  },
  {
    name: 'bio-research-plugin',
    description: 'Literature search, genomics with PubMed, BioRender, Benchling',
    gitUrl: 'https://github.com/anthropics/knowledge-work-plugins.git',
    ref: 'main',
    category: 'research',
  },

  // -------------------------------------------------------------------------
  // Financial Services Plugins
  // -------------------------------------------------------------------------
  {
    name: 'financial-analysis-plugin',
    description: 'Comps, DCF, LBO models with data connectors for Daloopa, Morningstar, S&P Global, FactSet',
    gitUrl: 'https://github.com/anthropics/financial-services-plugins.git',
    ref: 'main',
    category: 'finance',
  },
  {
    name: 'investment-banking-plugin',
    description: 'CIMs, teasers, buyer lists, merger models',
    gitUrl: 'https://github.com/anthropics/financial-services-plugins.git',
    ref: 'main',
    category: 'finance',
  },
  {
    name: 'equity-research-plugin',
    description: 'Earnings updates, investment theses',
    gitUrl: 'https://github.com/anthropics/financial-services-plugins.git',
    ref: 'main',
    category: 'finance',
  },
  {
    name: 'private-equity-plugin',
    description: 'Deal sourcing, due diligence, IC memos',
    gitUrl: 'https://github.com/anthropics/financial-services-plugins.git',
    ref: 'main',
    category: 'finance',
  },
  {
    name: 'wealth-management-plugin',
    description: 'Financial plans, portfolio rebalancing',
    gitUrl: 'https://github.com/anthropics/financial-services-plugins.git',
    ref: 'main',
    category: 'finance',
  },

  // -------------------------------------------------------------------------
  // Life Sciences & Healthcare Plugins
  // -------------------------------------------------------------------------
  {
    name: 'life-sciences-plugin',
    description: 'PubMed, BioRender, Synapse.org, 10x Genomics integration',
    gitUrl: 'https://github.com/anthropics/life-sciences.git',
    ref: 'main',
    category: 'research',
  },
  {
    name: 'healthcare-plugin',
    description: 'FHIR Developer, Prior Auth, Clinical Trial Protocol with CMS Coverage, NPI Registry',
    gitUrl: 'https://github.com/anthropics/healthcare.git',
    ref: 'main',
    category: 'healthcare',
  },
];

// =============================================================================
// Official Skills from anthropics/skills
// =============================================================================

interface SkillDef {
  name: string;
  displayName: string;
  description: string;
  body: string;
  category: string;
}

const OFFICIAL_SKILLS: SkillDef[] = [
  // -------------------------------------------------------------------------
  // Document Processing Skills
  // -------------------------------------------------------------------------
  {
    name: 'docx-processor',
    displayName: 'DOCX Processor',
    description: 'Process and analyze Microsoft Word documents',
    body: `## DOCX Processing Skill

This skill enables processing of Microsoft Word (.docx) files.

### Capabilities
- Extract text content from DOCX files
- Parse document structure (headings, paragraphs, lists)
- Extract tables and convert to markdown
- Handle embedded images and metadata

### Usage
When a user provides a DOCX file:
1. Use unzip to extract word/document.xml
2. Parse XML to extract text content
3. Convert formatting to markdown
4. Present structured content to user

### Commands
\`\`\`bash
# Extract text from DOCX
unzip -p document.docx word/document.xml | sed -e 's/<[^>]*>//g'
\`\`\``,
    category: 'document',
  },
  {
    name: 'pdf-processor',
    displayName: 'PDF Processor',
    description: 'Process and analyze PDF documents',
    body: `## PDF Processing Skill

This skill enables processing of PDF files.

### Capabilities
- Extract text content from PDFs
- Handle scanned documents with OCR
- Extract metadata and structure
- Process multi-page documents

### Usage
When a user provides a PDF file:
1. Use pdftotext to extract content
2. Fall back to strings for binary PDFs
3. Structure content by pages
4. Present formatted content

### Commands
\`\`\`bash
# Extract text from PDF
pdftotext document.pdf - 2>/dev/null || strings document.pdf
\`\`\``,
    category: 'document',
  },
  {
    name: 'xlsx-processor',
    displayName: 'Excel Processor',
    description: 'Process and analyze Microsoft Excel spreadsheets',
    body: `## Excel Processing Skill

This skill enables processing of Excel (.xlsx) files.

### Capabilities
- Extract data from worksheets
- Parse formulas and values
- Convert to CSV or markdown tables
- Handle multiple sheets

### Usage
When a user provides an XLSX file:
1. Use unzip to extract sheet data
2. Parse shared strings and sheet XML
3. Convert to tabular format
4. Present as markdown tables`,
    category: 'document',
  },
  {
    name: 'pptx-processor',
    displayName: 'PowerPoint Processor',
    description: 'Process and analyze Microsoft PowerPoint presentations',
    body: `## PowerPoint Processing Skill

This skill enables processing of PowerPoint (.pptx) files.

### Capabilities
- Extract slide content and notes
- Parse text, shapes, and tables
- Extract slide structure
- Handle speaker notes

### Usage
When a user provides a PPTX file:
1. Use unzip to extract slide XML files
2. Parse each slide's content
3. Extract speaker notes
4. Present slide-by-slide content`,
    category: 'document',
  },

  // -------------------------------------------------------------------------
  // Code Quality Skills
  // -------------------------------------------------------------------------
  {
    name: 'code-review',
    displayName: 'Code Review',
    description: 'Comprehensive code review following best practices',
    body: `## Code Review Skill

Perform thorough code reviews focusing on quality, security, and maintainability.

### Review Checklist
1. **Functionality**: Does the code do what it's supposed to?
2. **Security**: Check for OWASP Top 10 vulnerabilities
3. **Performance**: Identify bottlenecks and optimization opportunities
4. **Readability**: Is the code clear and well-documented?
5. **Testing**: Are there adequate tests?
6. **Error Handling**: Are errors handled gracefully?

### Review Format
- Start with overall assessment
- List specific issues with line numbers
- Provide concrete suggestions for improvement
- Highlight good practices found`,
    category: 'development',
  },
  {
    name: 'typescript-best-practices',
    displayName: 'TypeScript Best Practices',
    description: 'TypeScript coding standards and best practices',
    body: `## TypeScript Best Practices

### Type Safety
- Use strict mode
- Avoid \`any\` type - use \`unknown\` if type is truly unknown
- Define explicit return types for functions
- Use type guards for narrowing

### Patterns
- Prefer interfaces for object shapes
- Use discriminated unions for state
- Leverage const assertions
- Use template literal types

### Code Style
- Use ESLint with @typescript-eslint
- Configure Prettier for formatting
- Use path aliases for imports
- Organize imports with consistent ordering

### Error Handling
- Use custom error classes
- Leverage Result/Either patterns for expected errors
- Type error responses`,
    category: 'language',
  },
  {
    name: 'python-best-practices',
    displayName: 'Python Best Practices',
    description: 'Python coding standards and best practices (PEP 8, type hints)',
    body: `## Python Best Practices

### Style Guide (PEP 8)
- 4 spaces for indentation
- Max line length 88 (Black default) or 79 (PEP 8)
- Use snake_case for functions and variables
- Use PascalCase for classes

### Type Hints (PEP 484)
- Add type hints to function signatures
- Use typing module for complex types
- Run mypy for static type checking

### Code Quality
- Use Black for formatting
- Use isort for import sorting
- Use flake8 or ruff for linting
- Use pytest for testing

### Patterns
- Use context managers for resources
- Prefer list/dict comprehensions
- Use dataclasses for data containers
- Use pathlib for file paths`,
    category: 'language',
  },
  {
    name: 'go-best-practices',
    displayName: 'Go Best Practices',
    description: 'Go coding standards and idiomatic patterns',
    body: `## Go Best Practices

### Style
- Use gofmt/goimports for formatting
- Follow Effective Go guidelines
- Use golangci-lint for linting

### Naming
- Use MixedCaps (not underscores)
- Short names for local variables
- Descriptive names for exported items
- Interface names end in -er when single method

### Patterns
- Return errors, don't panic
- Use defer for cleanup
- Prefer composition over inheritance
- Use context for cancellation

### Testing
- Table-driven tests
- Use testify for assertions
- Use httptest for HTTP testing
- Benchmark critical paths`,
    category: 'language',
  },
  {
    name: 'rust-best-practices',
    displayName: 'Rust Best Practices',
    description: 'Rust coding standards and ownership patterns',
    body: `## Rust Best Practices

### Style
- Use rustfmt for formatting
- Use clippy for linting
- Follow Rust API Guidelines

### Ownership
- Prefer borrowing over ownership transfer
- Use lifetimes explicitly when needed
- Leverage RAII for resource management

### Error Handling
- Use Result for recoverable errors
- Use panic! only for unrecoverable errors
- Create custom error types with thiserror
- Use anyhow for applications

### Patterns
- Use Option instead of null
- Leverage pattern matching
- Use iterators over loops
- Prefer &str over String in function params`,
    category: 'language',
  },
  {
    name: 'java-best-practices',
    displayName: 'Java Best Practices',
    description: 'Java coding standards and modern patterns',
    body: `## Java Best Practices

### Style
- Follow Google Java Style Guide
- Use consistent naming conventions
- Organize imports properly

### Modern Java (17+)
- Use records for data classes
- Use sealed classes for type hierarchies
- Leverage pattern matching
- Use var for local type inference

### Patterns
- Prefer composition over inheritance
- Use Optional instead of null
- Use streams for collection processing
- Leverage functional interfaces

### Testing
- Use JUnit 5
- Use Mockito for mocking
- Write descriptive test names
- Test edge cases`,
    category: 'language',
  },

  // -------------------------------------------------------------------------
  // Testing Skills
  // -------------------------------------------------------------------------
  {
    name: 'test-driven-development',
    displayName: 'Test-Driven Development',
    description: 'TDD workflow: Red-Green-Refactor cycle',
    body: `## Test-Driven Development

### The TDD Cycle
1. **Red**: Write a failing test first
2. **Green**: Write minimal code to pass the test
3. **Refactor**: Improve code while keeping tests green

### Guidelines
- One assertion per test (when possible)
- Test behavior, not implementation
- Use descriptive test names
- Keep tests fast and isolated

### Test Structure (AAA)
- **Arrange**: Set up test data and conditions
- **Act**: Execute the code under test
- **Assert**: Verify the expected outcome

### When to Use
- New features
- Bug fixes (write test that reproduces bug first)
- Refactoring (ensure tests exist before changing)`,
    category: 'testing',
  },
  {
    name: 'api-testing',
    displayName: 'API Testing',
    description: 'REST API testing strategies and patterns',
    body: `## API Testing Skill

### Test Categories
1. **Contract Tests**: Validate API schema
2. **Functional Tests**: Verify business logic
3. **Integration Tests**: Test with real dependencies
4. **Performance Tests**: Load and stress testing

### Test Cases
- Happy path scenarios
- Error responses (400, 401, 403, 404, 500)
- Edge cases and boundary conditions
- Authentication and authorization
- Rate limiting behavior

### Tools
- Jest/Vitest for JavaScript
- pytest for Python
- Postman/Newman for manual + CI
- k6 for load testing`,
    category: 'testing',
  },

  // -------------------------------------------------------------------------
  // Security Skills
  // -------------------------------------------------------------------------
  {
    name: 'security-review',
    displayName: 'Security Review',
    description: 'Security code review following OWASP guidelines',
    body: `## Security Review Skill

### OWASP Top 10 Checks
1. **Injection**: SQL, NoSQL, OS command, LDAP
2. **Broken Authentication**: Session management, credentials
3. **Sensitive Data Exposure**: Encryption, PII handling
4. **XXE**: XML external entities
5. **Broken Access Control**: Authorization checks
6. **Security Misconfiguration**: Default settings, headers
7. **XSS**: Input validation, output encoding
8. **Insecure Deserialization**: Object injection
9. **Using Components with Vulnerabilities**: Dependencies
10. **Insufficient Logging**: Audit trails

### Review Process
1. Map attack surface
2. Review authentication/authorization
3. Check input validation
4. Verify encryption usage
5. Review error handling
6. Check dependencies for CVEs`,
    category: 'security',
  },

  // -------------------------------------------------------------------------
  // DevOps Skills
  // -------------------------------------------------------------------------
  {
    name: 'docker-best-practices',
    displayName: 'Docker Best Practices',
    description: 'Docker image optimization and security',
    body: `## Docker Best Practices

### Image Optimization
- Use multi-stage builds
- Choose minimal base images (alpine, distroless)
- Order layers for better caching
- Use .dockerignore

### Security
- Don't run as root
- Scan images for vulnerabilities
- Use specific version tags
- Don't store secrets in images

### Dockerfile Guidelines
\`\`\`dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
RUN adduser -D appuser
USER appuser
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
\`\`\``,
    category: 'devops',
  },
  {
    name: 'kubernetes-best-practices',
    displayName: 'Kubernetes Best Practices',
    description: 'Kubernetes deployment patterns and security',
    body: `## Kubernetes Best Practices

### Resource Management
- Set resource requests and limits
- Use horizontal pod autoscaling
- Configure pod disruption budgets

### Security
- Use network policies
- Enable RBAC
- Run as non-root
- Use security contexts
- Scan container images

### Deployment Strategies
- Rolling updates (default)
- Blue-green deployments
- Canary releases
- Feature flags

### Observability
- Liveness and readiness probes
- Structured logging
- Metrics with Prometheus
- Distributed tracing`,
    category: 'devops',
  },
  {
    name: 'ci-cd-best-practices',
    displayName: 'CI/CD Best Practices',
    description: 'Continuous Integration and Deployment patterns',
    body: `## CI/CD Best Practices

### Pipeline Stages
1. **Build**: Compile, bundle, containerize
2. **Test**: Unit, integration, e2e
3. **Scan**: Security, dependencies, secrets
4. **Deploy**: Staging, production
5. **Verify**: Smoke tests, monitoring

### Best Practices
- Fast feedback (< 10 min for CI)
- Fail fast (run quick checks first)
- Parallelize where possible
- Cache dependencies
- Use matrix builds for multiple versions
- Implement proper secrets management

### Deployment
- Infrastructure as Code
- GitOps workflows
- Automated rollbacks
- Feature flags for gradual rollout`,
    category: 'devops',
  },

  // -------------------------------------------------------------------------
  // Architecture Skills
  // -------------------------------------------------------------------------
  {
    name: 'system-design',
    displayName: 'System Design',
    description: 'System architecture and design patterns',
    body: `## System Design Skill

### Design Process
1. **Requirements**: Functional and non-functional
2. **Estimation**: Scale, storage, bandwidth
3. **High-level Design**: Components, data flow
4. **Detailed Design**: APIs, schemas, algorithms
5. **Bottlenecks**: Identify and address

### Key Concepts
- CAP theorem
- Consistency patterns
- Caching strategies
- Load balancing
- Database sharding
- Message queues
- Microservices vs monolith

### Non-functional Requirements
- Scalability (horizontal/vertical)
- Availability (SLAs, redundancy)
- Performance (latency, throughput)
- Security (authentication, encryption)`,
    category: 'architecture',
  },
  {
    name: 'api-design',
    displayName: 'API Design',
    description: 'RESTful API design principles and patterns',
    body: `## API Design Skill

### REST Principles
- Use nouns for resources
- HTTP methods for actions
- Consistent naming (kebab-case)
- Versioning strategy (URL or header)

### Response Format
- Consistent structure
- Proper HTTP status codes
- Pagination for lists
- HATEOAS for discoverability

### Best Practices
- Idempotent operations
- Proper error responses
- Rate limiting
- API documentation (OpenAPI)
- Input validation

### Security
- Authentication (JWT, OAuth2)
- Authorization (RBAC, ABAC)
- Input sanitization
- HTTPS only`,
    category: 'architecture',
  },
];

// =============================================================================
// Main Seeding Function
// =============================================================================

async function seedOfficialMcpServers(orgId: string) {
  console.log('Seeding official MCP servers...');

  for (const server of OFFICIAL_MCP_SERVERS) {
    const existing = await prisma.mcp_servers.findFirst({
      where: { organization_id: orgId, name: server.name },
    });

    if (existing) {
      console.log(`  [skip] ${server.name} already exists`);
      continue;
    }

    await prisma.mcp_servers.create({
      data: {
        organization_id: orgId,
        name: server.name,
        description: server.description,
        host_address: server.hostAddress,
        config: server.config,
        status: 'active',
      },
    });
    console.log(`  [created] ${server.name}`);
  }
}

async function seedOfficialSkills(orgId: string) {
  console.log('Seeding official skills...');

  for (const skill of OFFICIAL_SKILLS) {
    const existing = await prisma.skills.findFirst({
      where: { organization_id: orgId, name: skill.name },
    });

    if (existing) {
      console.log(`  [skip] ${skill.name} already exists`);
      continue;
    }

    await prisma.skills.create({
      data: {
        organization_id: orgId,
        name: skill.name,
        display_name: skill.displayName,
        description: skill.description,
        hash_id: `official-${skill.name}`,
        s3_bucket: '',
        s3_prefix: '',
        metadata: {
          body: skill.body,
          category: skill.category,
          source: 'anthropic-official',
        },
      },
    });
    console.log(`  [created] ${skill.name}`);
  }
}

async function seedOfficialPlugins(orgId: string) {
  console.log('Seeding official plugins (as scope_plugins reference)...');

  // Plugins are typically attached per-scope via scope_plugins table
  // Here we just log what's available
  for (const plugin of OFFICIAL_PLUGINS) {
    console.log(`  [available] ${plugin.name}: ${plugin.gitUrl}`);
  }
  console.log('  Note: Plugins should be attached to specific business scopes via scope_plugins');
}

async function main() {
  console.log('='.repeat(60));
  console.log('Seeding Official Anthropic MCP Servers, Skills, and Plugins');
  console.log('='.repeat(60));

  // Find or create a system organization for official resources
  let org = await prisma.organizations.findFirst({
    where: { slug: 'system' },
  });

  if (!org) {
    // If no system org, use the first available org
    org = await prisma.organizations.findFirst();
    if (!org) {
      console.error('No organization found. Please create an organization first.');
      process.exit(1);
    }
  }

  console.log(`Using organization: ${org.name} (${org.id})`);
  console.log('');

  await seedOfficialMcpServers(org.id);
  console.log('');

  await seedOfficialSkills(org.id);
  console.log('');

  await seedOfficialPlugins(org.id);
  console.log('');

  console.log('='.repeat(60));
  console.log('Seeding complete!');
  console.log('='.repeat(60));
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
