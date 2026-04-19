/**
 * Seed script for additional Programming Language Skills
 *
 * Run with: docker exec super-agent-backend npx tsx prisma/seed-language-skills.ts
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://super_agent:super_agent_dev@postgres:5432/super_agent';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface SkillDef {
  name: string;
  displayName: string;
  description: string;
  body: string;
  category: string;
}

const LANGUAGE_SKILLS: SkillDef[] = [
  // -------------------------------------------------------------------------
  // Additional Language Best Practices
  // -------------------------------------------------------------------------
  {
    name: 'javascript-best-practices',
    displayName: 'JavaScript Best Practices',
    description: 'Modern JavaScript (ES2024+) coding standards and patterns',
    body: `## JavaScript Best Practices

### Modern Features (ES2024+)
- Use const by default, let when needed, never var
- Destructuring for objects and arrays
- Spread operator for copies
- Optional chaining (?.) and nullish coalescing (??)
- Array methods: map, filter, reduce, find, some, every

### Async Patterns
- Prefer async/await over .then() chains
- Use Promise.all for parallel operations
- Use Promise.allSettled for fault-tolerant parallel ops
- Handle errors with try/catch

### Code Quality
- Use ESLint with recommended rules
- Configure Prettier for formatting
- Write pure functions when possible
- Avoid mutation of arguments

### Module System
- Use ES modules (import/export)
- Barrel files for clean exports
- Dynamic imports for code splitting`,
    category: 'language',
  },
  {
    name: 'react-best-practices',
    displayName: 'React Best Practices',
    description: 'React 19+ patterns, hooks, and performance optimization',
    body: `## React Best Practices

### Component Patterns
- Functional components only (no class components)
- Custom hooks for reusable logic
- Compound components for flexibility
- Render props for advanced composition

### Hooks Best Practices
- useState for simple state
- useReducer for complex state logic
- useMemo/useCallback for optimization
- useEffect cleanup functions
- Custom hooks prefix with "use"

### Performance
- React.memo for expensive components
- useMemo for expensive calculations
- Virtualization for long lists
- Code splitting with lazy/Suspense

### State Management
- useState for local state
- Context for shared state
- Consider Zustand/Jotai for global state
- Server state with TanStack Query

### Patterns to Avoid
- Prop drilling (use Context)
- useEffect for derived state
- Index as key in lists
- Direct DOM manipulation`,
    category: 'framework',
  },
  {
    name: 'nodejs-best-practices',
    displayName: 'Node.js Best Practices',
    description: 'Node.js server-side patterns and security',
    body: `## Node.js Best Practices

### Project Structure
- Separate concerns (routes, services, repositories)
- Use environment variables for config
- Centralized error handling
- Structured logging (pino, winston)

### Async Patterns
- Always handle promise rejections
- Use async/await over callbacks
- Avoid callback hell
- Use streams for large data

### Security
- Input validation (zod, joi)
- Sanitize user input
- Use helmet for HTTP headers
- Rate limiting
- CORS configuration

### Performance
- Use clustering for multi-core
- Connection pooling for databases
- Cache frequently accessed data
- Use streams for large responses

### Error Handling
\`\`\`typescript
// Custom error class
class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string
  ) {
    super(message);
  }
}
\`\`\``,
    category: 'runtime',
  },
  {
    name: 'csharp-best-practices',
    displayName: 'C# Best Practices',
    description: 'C# 12+ coding standards and .NET patterns',
    body: `## C# Best Practices

### Modern C# Features
- Primary constructors
- Collection expressions
- Pattern matching
- Records for data
- Required members

### Naming Conventions
- PascalCase for public members
- camelCase for private fields
- _prefix for private fields (optional)
- I prefix for interfaces

### Async Patterns
- async/await for I/O
- ValueTask for hot paths
- ConfigureAwait(false) in libraries
- Avoid async void

### LINQ Best Practices
- Use method syntax for complex queries
- Avoid multiple enumerations
- Use AsNoTracking for read-only

### Dependency Injection
- Constructor injection
- Interface segregation
- Scoped services for request lifetime`,
    category: 'language',
  },
  {
    name: 'kotlin-best-practices',
    displayName: 'Kotlin Best Practices',
    description: 'Kotlin idioms and Android/JVM patterns',
    body: `## Kotlin Best Practices

### Idiomatic Kotlin
- Use data classes for DTOs
- Prefer val over var
- Use sealed classes for state
- Extension functions for utilities
- Scope functions (let, run, with, apply, also)

### Null Safety
- Use nullable types explicitly
- Elvis operator (?:) for defaults
- Safe calls (?.) for chains
- Avoid !! operator

### Coroutines
- Use suspend functions
- Structured concurrency
- CoroutineScope for lifecycle
- Flow for reactive streams

### Android Specific
- ViewModel for UI state
- LiveData/StateFlow for observation
- Hilt for dependency injection
- Compose for modern UI`,
    category: 'language',
  },
  {
    name: 'swift-best-practices',
    displayName: 'Swift Best Practices',
    description: 'Swift 6+ patterns and iOS development',
    body: `## Swift Best Practices

### Style Guide
- Use Swift naming conventions
- Prefer structs over classes
- Use extensions for organization
- Protocol-oriented programming

### Modern Swift
- Async/await for concurrency
- Actors for state isolation
- Sendable for thread safety
- Result builders for DSLs

### Optionals
- Use if let / guard let
- Avoid force unwrapping
- Use optional chaining
- Provide default values

### SwiftUI
- State management with @State, @Binding
- ObservableObject for shared state
- Environment for dependency injection
- PreviewProvider for development

### Memory Management
- Understand ARC
- Use weak/unowned for cycles
- Avoid retain cycles in closures`,
    category: 'language',
  },
  {
    name: 'sql-best-practices',
    displayName: 'SQL Best Practices',
    description: 'SQL query optimization and database design',
    body: `## SQL Best Practices

### Query Optimization
- Use indexes for WHERE, JOIN, ORDER BY columns
- Avoid SELECT * in production
- Use EXPLAIN ANALYZE to profile
- Batch large operations

### Design Principles
- Normalize to 3NF typically
- Denormalize for read performance
- Use appropriate data types
- Add constraints (NOT NULL, UNIQUE, FK)

### Security
- Use parameterized queries
- Never concatenate user input
- Principle of least privilege
- Audit sensitive operations

### Performance Patterns
\`\`\`sql
-- Use EXISTS instead of IN for large sets
SELECT * FROM orders o
WHERE EXISTS (
  SELECT 1 FROM customers c
  WHERE c.id = o.customer_id
  AND c.status = 'active'
);

-- Pagination with keyset
SELECT * FROM items
WHERE id > :last_id
ORDER BY id
LIMIT 20;
\`\`\``,
    category: 'database',
  },
  {
    name: 'graphql-best-practices',
    displayName: 'GraphQL Best Practices',
    description: 'GraphQL schema design and resolver patterns',
    body: `## GraphQL Best Practices

### Schema Design
- Use clear, descriptive names
- Leverage custom scalars
- Design for use cases, not data
- Version through evolution

### Query Patterns
- Use fragments for reuse
- Implement pagination (Relay style)
- Design for batching
- Consider complexity limits

### Resolver Best Practices
- Use DataLoader for N+1
- Handle errors gracefully
- Implement authorization
- Cache where appropriate

### Performance
- Query complexity analysis
- Depth limiting
- Field-level caching
- Persisted queries

### Security
- Input validation
- Rate limiting
- Query whitelisting (production)
- Disable introspection (production)`,
    category: 'api',
  },
  {
    name: 'terraform-best-practices',
    displayName: 'Terraform Best Practices',
    description: 'Infrastructure as Code with Terraform',
    body: `## Terraform Best Practices

### Project Structure
\`\`\`
├── modules/
│   └── vpc/
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── environments/
│   ├── dev/
│   └── prod/
└── main.tf
\`\`\`

### State Management
- Remote state backend (S3, GCS)
- State locking (DynamoDB)
- Workspace per environment
- Never store state in git

### Code Quality
- Use consistent formatting (terraform fmt)
- Validate before apply
- Use modules for reuse
- Tag all resources

### Security
- Use variables for secrets
- Integrate with secrets manager
- Least privilege IAM
- Enable encryption`,
    category: 'devops',
  },
  {
    name: 'aws-cdk-best-practices',
    displayName: 'AWS CDK Best Practices',
    description: 'AWS CDK patterns and constructs',
    body: `## AWS CDK Best Practices

### Project Structure
- Separate stacks by lifecycle
- Use constructs for reuse
- Environment-specific configuration
- Aspects for cross-cutting concerns

### Patterns
\`\`\`typescript
// L3 construct pattern
export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'my-api',
    });
  }
}
\`\`\`

### Best Practices
- Use cdk.context.json for lookups
- Prefer L2 over L1 constructs
- Tag resources consistently
- Use CDK Nag for compliance

### Testing
- Snapshot tests for constructs
- Fine-grained assertions
- Integration tests for critical paths`,
    category: 'devops',
  },

  // -------------------------------------------------------------------------
  // Framework-specific Skills
  // -------------------------------------------------------------------------
  {
    name: 'nextjs-best-practices',
    displayName: 'Next.js Best Practices',
    description: 'Next.js 14+ App Router patterns and optimization',
    body: `## Next.js Best Practices

### App Router Patterns
- Use Server Components by default
- 'use client' only when needed
- Parallel routes for complex UIs
- Intercepting routes for modals

### Data Fetching
- Server Components for data
- Use cache() for deduplication
- Streaming with Suspense
- Route handlers for APIs

### Performance
- Image optimization with next/image
- Font optimization with next/font
- Metadata API for SEO
- Generate static params

### Patterns
\`\`\`typescript
// Server Component
async function Page({ params }: { params: { id: string } }) {
  const data = await fetch(\`/api/items/\${params.id}\`);
  return <Component data={data} />;
}

// With Suspense
export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <AsyncComponent />
    </Suspense>
  );
}
\`\`\``,
    category: 'framework',
  },
  {
    name: 'fastapi-best-practices',
    displayName: 'FastAPI Best Practices',
    description: 'FastAPI patterns and async Python APIs',
    body: `## FastAPI Best Practices

### Project Structure
\`\`\`
app/
├── main.py
├── routers/
├── models/
├── schemas/
├── services/
└── dependencies.py
\`\`\`

### Patterns
\`\`\`python
from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel

class ItemCreate(BaseModel):
    name: str
    price: float

@app.post("/items/", response_model=Item)
async def create_item(
    item: ItemCreate,
    db: Session = Depends(get_db)
):
    return await item_service.create(db, item)
\`\`\`

### Best Practices
- Pydantic for validation
- Dependency injection
- Background tasks for async ops
- Middleware for cross-cutting

### Performance
- Use async database drivers
- Connection pooling
- Response caching
- Gzip compression`,
    category: 'framework',
  },
  {
    name: 'spring-boot-best-practices',
    displayName: 'Spring Boot Best Practices',
    description: 'Spring Boot 3+ patterns and microservices',
    body: `## Spring Boot Best Practices

### Project Structure
- Layer architecture (controller, service, repository)
- Package by feature for larger apps
- External configuration
- Profile-based environments

### Patterns
\`\`\`java
@RestController
@RequestMapping("/api/items")
public class ItemController {

    private final ItemService itemService;

    public ItemController(ItemService itemService) {
        this.itemService = itemService;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Item> getItem(@PathVariable Long id) {
        return itemService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }
}
\`\`\`

### Best Practices
- Constructor injection
- Use records for DTOs
- Validation with @Valid
- Global exception handling

### Observability
- Spring Actuator for metrics
- Structured logging
- Distributed tracing
- Health checks`,
    category: 'framework',
  },
  {
    name: 'django-best-practices',
    displayName: 'Django Best Practices',
    description: 'Django 5+ patterns and DRF APIs',
    body: `## Django Best Practices

### Project Structure
\`\`\`
project/
├── config/
│   ├── settings/
│   │   ├── base.py
│   │   ├── local.py
│   │   └── production.py
│   ├── urls.py
│   └── wsgi.py
└── apps/
    └── users/
        ├── models.py
        ├── views.py
        ├── serializers.py
        └── tests.py
\`\`\`

### Best Practices
- Fat models, thin views
- Use managers for queries
- Custom user model from start
- Django REST Framework for APIs

### Security
- Use Django's built-in protection
- Configure CORS properly
- Validate all input
- Use environment variables

### Performance
- Select/prefetch related
- Database indexing
- Caching with Redis
- Async views (Django 4.1+)`,
    category: 'framework',
  },

  // -------------------------------------------------------------------------
  // Testing Framework Skills
  // -------------------------------------------------------------------------
  {
    name: 'jest-testing',
    displayName: 'Jest Testing',
    description: 'Jest testing patterns for JavaScript/TypeScript',
    body: `## Jest Testing Best Practices

### Test Structure
\`\`\`typescript
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with valid data', async () => {
      // Arrange
      const userData = { name: 'John', email: 'john@example.com' };

      // Act
      const user = await userService.createUser(userData);

      // Assert
      expect(user).toMatchObject(userData);
      expect(user.id).toBeDefined();
    });

    it('should throw on duplicate email', async () => {
      await expect(userService.createUser(existingUser))
        .rejects.toThrow('Email already exists');
    });
  });
});
\`\`\`

### Mocking
- jest.mock for modules
- jest.spyOn for methods
- jest.fn for functions
- mockResolvedValue for async

### Best Practices
- One assertion per test
- Use factories for test data
- Clean up after tests
- Avoid testing implementation`,
    category: 'testing',
  },
  {
    name: 'pytest-testing',
    displayName: 'Pytest Testing',
    description: 'Pytest patterns for Python testing',
    body: `## Pytest Best Practices

### Fixtures
\`\`\`python
import pytest

@pytest.fixture
def db_session():
    session = create_session()
    yield session
    session.rollback()
    session.close()

@pytest.fixture
def user(db_session):
    return UserFactory.create()

def test_user_creation(db_session, user):
    assert user.id is not None
    assert db_session.query(User).count() == 1
\`\`\`

### Parametrization
\`\`\`python
@pytest.mark.parametrize("input,expected", [
    ("hello", "HELLO"),
    ("world", "WORLD"),
])
def test_uppercase(input, expected):
    assert input.upper() == expected
\`\`\`

### Best Practices
- Use fixtures for setup
- Parametrize for variations
- Use markers for categories
- conftest.py for shared fixtures`,
    category: 'testing',
  },
  {
    name: 'playwright-testing',
    displayName: 'Playwright Testing',
    description: 'End-to-end testing with Playwright',
    body: `## Playwright Best Practices

### Page Object Pattern
\`\`\`typescript
class LoginPage {
  constructor(private page: Page) {}

  async login(email: string, password: string) {
    await this.page.fill('[data-testid="email"]', email);
    await this.page.fill('[data-testid="password"]', password);
    await this.page.click('[data-testid="submit"]');
  }
}

test('user can login', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await page.goto('/login');
  await loginPage.login('user@example.com', 'password');
  await expect(page).toHaveURL('/dashboard');
});
\`\`\`

### Best Practices
- Use data-testid for selectors
- Wait for network idle
- Use fixtures for auth state
- Parallel test execution
- Screenshot on failure`,
    category: 'testing',
  },
];

async function seedLanguageSkills(orgId: string) {
  console.log('Seeding additional language skills...');

  for (const skill of LANGUAGE_SKILLS) {
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

async function main() {
  console.log('='.repeat(60));
  console.log('Seeding Additional Programming Language Skills');
  console.log('='.repeat(60));

  let org = await prisma.organizations.findFirst({
    where: { slug: 'system' },
  });

  if (!org) {
    org = await prisma.organizations.findFirst();
    if (!org) {
      console.error('No organization found.');
      process.exit(1);
    }
  }

  console.log(`Using organization: ${org.name} (${org.id})`);
  console.log('');

  await seedLanguageSkills(org.id);

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
