import {
  graphql,
  GraphQLSchema,
  GraphQLField,
  GraphQLObjectType,
  GraphQLScalarType,
  subscribe,
  parse,
  ExecutionResult,
  defaultFieldResolver,
  findDeprecatedUsages,
  printSchema,
} from 'graphql';

import { delegateToSchema, SubschemaConfig } from '@graphql-tools/delegate';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { stitchSchemas } from '../src/stitchSchemas';
import {
  cloneSchema,
  getResolversFromSchema,
  SchemaDirectiveVisitor,
  IResolvers,
} from '@graphql-tools/utils';
import { addMocksToSchema } from '@graphql-tools/mock';

import { forAwaitEach } from './forAwaitEach';

import {
  propertySchema as localPropertySchema,
  productSchema as localProductSchema,
  bookingSchema as localBookingSchema,
  subscriptionSchema as localSubscriptionSchema,
  remoteBookingSchema,
  remotePropertySchema,
  remoteProductSchema,
  subscriptionPubSub,
  subscriptionPubSubTrigger,
} from './fixtures/schemas';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const removeLocations = ({ locations, ...rest }: any): any => ({ ...rest });

const testCombinations = [
  {
    name: 'local',
    booking: localBookingSchema,
    property: localPropertySchema,
    product: localProductSchema,
  },
  {
    name: 'remote',
    booking: remoteBookingSchema,
    property: remotePropertySchema,
    product: remoteProductSchema,
  },
  {
    name: 'hybrid',
    booking: localBookingSchema,
    property: remotePropertySchema,
    product: localProductSchema,
  },
  {
    name: 'recreated',
    booking: cloneSchema(localBookingSchema),
    property: makeExecutableSchema({
      typeDefs: printSchema(localPropertySchema),
      resolvers: getResolversFromSchema(localPropertySchema),
    }),
    product: cloneSchema(localProductSchema),
  },
];

const scalarTest = `
  """
  Description of TestScalar.
  """
  scalar TestScalar

  """
  Description of AnotherNewScalar.
  """
  scalar AnotherNewScalar

  """
  A type that uses TestScalar.
  """
  type TestingScalar {
    value: TestScalar
  }

  type Query {
    testingScalar(input: TestScalar): TestingScalar
    listTestingScalar(input: TestScalar): [TestingScalar]
  }
`;

const scalarSchema = makeExecutableSchema({
  typeDefs: scalarTest,
  resolvers: {
    TestScalar: new GraphQLScalarType({
      name: 'TestScalar',
      description: undefined,
      serialize: (value) => (value as string).slice(1),
      parseValue: (value) => `_${value as string}`,
      parseLiteral: (ast: any) => `_${ast.value as string}`,
    }),
    Query: {
      testingScalar(_parent, args) {
        return {
          value: args.input[0] === '_' ? args.input : null,
        };
      },
      listTestingScalar(_parent, args) {
        return [
          {
            value: args.input[0] === '_' ? args.input : null,
          },
        ];
      },
    },
  },
});

const enumTest = `
  """
  A type that uses an Enum.
  """
  enum Color {
    """
    A vivid color
    """
    RED
  }

  """
  A type that uses an Enum with a numeric constant.
  """
  enum NumericEnum {
    """
    A test description
    """
    TEST @deprecated(reason: "This is deprecated")
  }

  type EnumWrapper {
    color: Color
    numericEnum: NumericEnum
  }

  union UnionWithEnum = EnumWrapper

  schema {
    query: Query
  }

  type Query {
    color(input: Color): Color
    numericEnum: NumericEnum
    listNumericEnum: [NumericEnum]
    wrappedEnum: EnumWrapper
    unionWithEnum: UnionWithEnum
  }
`;

const enumSchema = makeExecutableSchema({
  typeDefs: enumTest,
  resolvers: {
    Color: {
      RED: '#EA3232',
    },
    NumericEnum: {
      TEST: 1,
    },
    UnionWithEnum: {
      __resolveType: () => 'EnumWrapper',
    },
    Query: {
      color(_parent, args) {
        return args.input === '#EA3232' ? args.input : null;
      },
      numericEnum() {
        return 1;
      },
      listNumericEnum() {
        return [1];
      },
      wrappedEnum() {
        return {
          color: '#EA3232',
          numericEnum: 1,
        };
      },
      unionWithEnum() {
        return {
          color: '#EA3232',
          numericEnum: 1,
        };
      },
    },
  },
});

const linkSchema = `
  """
  A new type linking the Property type.
  """
  type LinkType {
    test: String
    """
    The property.
    """
    property: Property
  }

  interface Node {
    id: ID!
  }

  extend type Car implements Node

  extend type Bike implements Node

  extend type Booking implements Node {
    """
    The property of the booking.
    """
    property: Property
    """
    A textual description of the booking.
    """
    textDescription: String
  }

  extend type Property implements Node {
    """
    A list of bookings.
    """
    bookings(
      """
      The maximum number of bookings to retrieve.
      """
      limit: Int
    ): [Booking]
  }

  extend type Query {
    delegateInterfaceTest: TestInterface
    delegateArgumentTest(arbitraryArg: Int): Property
    """
    A new field on the root query.
    """
    linkTest: LinkType
    node(id: ID!): Node
    nodes: [Node]
  }

  extend type Customer implements Node
`;

const loneExtend = parse(`
  extend type Booking {
    foo: String!
  }
`);

let interfaceExtensionTest = `
  # No-op for older versions since this feature does not yet exist
  extend type DownloadableProduct {
    filesize: Int
  }
`;

interfaceExtensionTest = `
  extend interface Downloadable {
    filesize: Int
  }

  extend type DownloadableProduct {
    filesize: Int
  }
`;

// Miscellaneous typeDefs that exercise uncommon branches for the sake of
// code coverage.
const codeCoverageTypeDefs = `
  interface SyntaxNode {
    type: String
  }

  type Statement implements SyntaxNode {
    type: String
  }

  type Expression implements SyntaxNode {
    type: String
  }

  union ASTNode = Statement | Expression

  enum Direction {
    NORTH
    SOUTH
    EAST
    WEST
  }

  input WalkingPlan {
    steps: Int
    direction: Direction
  }
`;

const schemaDirectiveTypeDefs = `
  directive @upper on FIELD_DEFINITION

  directive @withEnumArg(enumArg: DirectiveEnum = FOO) on FIELD_DEFINITION

  enum DirectiveEnum {
    FOO
    BAR
  }

  extend type Property {
    someField: String! @upper
    someOtherField: String! @withEnumArg
    someThirdField: String! @withEnumArg(enumArg: BAR)
  }
`;

testCombinations.forEach((combination) => {
  describe('merging ' + combination.name, () => {
    let stitchedSchema: GraphQLSchema;
    let propertySchema: GraphQLSchema | SubschemaConfig;
    let productSchema: GraphQLSchema | SubschemaConfig;
    let bookingSchema: GraphQLSchema | SubschemaConfig;

    beforeAll(async () => {
      propertySchema = await combination.property;
      bookingSchema = await combination.booking;
      productSchema = await combination.product;

      stitchedSchema = stitchSchemas({
        schemas: [
          propertySchema,
          bookingSchema,
          productSchema,
          interfaceExtensionTest,
          scalarSchema,
          enumSchema,
          linkSchema,
          loneExtend,
          localSubscriptionSchema,
          codeCoverageTypeDefs,
          schemaDirectiveTypeDefs,
        ],
        schemaDirectives: {
          upper: class extends SchemaDirectiveVisitor {
            public visitFieldDefinition(field: GraphQLField<any, any>) {
              const { resolve = defaultFieldResolver } = field;
              field.resolve = async function (...args) {
                const result = await resolve.apply(this, args);
                if (typeof result === 'string') {
                  return result.toUpperCase();
                }
                return result;
              };
            }
          },
        },
        mergeDirectives: true,
        resolvers: {
          Property: {
            bookings: {
              selectionSet: '{ id }',
              resolve(parent, args, context, info) {
                return delegateToSchema({
                  schema: bookingSchema,
                  operation: 'query',
                  fieldName: 'bookingsByPropertyId',
                  args: {
                    propertyId: parent.id,
                    limit: args.limit ? args.limit : null,
                  },
                  context,
                  info,
                });
              },
            },
            someField: {
              resolve() {
                return 'someField';
              },
            },
          },
          Booking: {
            property: {
              selectionSet: '{ propertyId }',
              resolve(parent, _args, context, info) {
                return delegateToSchema({
                  schema: propertySchema,
                  operation: 'query',
                  fieldName: 'propertyById',
                  args: {
                    id: parent.propertyId,
                  },
                  context,
                  info,
                });
              },
            },
            textDescription: {
              selectionSet: '{ id }',
              resolve(parent, _args, _context, _info) {
                return `Booking #${parent.id as string}`;
              },
            },
          },
          DownloadableProduct: {
            filesize() {
              return 1024;
            },
          },
          LinkType: {
            property: {
              resolve(_parent, _args, context, info) {
                return delegateToSchema({
                  schema: propertySchema,
                  operation: 'query',
                  fieldName: 'propertyById',
                  args: {
                    id: 'p1',
                  },
                  context,
                  info,
                });
              },
            },
          },
          TestScalar: new GraphQLScalarType({
            name: 'TestScalar',
            description: undefined,
            serialize: (value) => value,
          }),
          Query: {
            delegateInterfaceTest(_parent, _args, context, info) {
              return delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'interfaceTest',
                args: {
                  kind: 'ONE',
                },
                context,
                info,
              });
            },
            delegateArgumentTest(_parent, _args, context, info) {
              return delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'propertyById',
                args: {
                  id: 'p1',
                },
                context,
                info,
              });
            },
            linkTest() {
              return {
                test: 'test',
              };
            },
            node: {
              selectionSet: '{ id }',
              resolve(_parent, args, context, info) {
                if (args.id.startsWith('p')) {
                  return delegateToSchema({
                    schema: propertySchema,
                    operation: 'query',
                    fieldName: 'propertyById',
                    args,
                    context,
                    info,
                  });
                } else if (args.id.startsWith('b')) {
                  return delegateToSchema({
                    schema: bookingSchema,
                    operation: 'query',
                    fieldName: 'bookingById',
                    args,
                    context,
                    info,
                  });
                } else if (args.id.startsWith('c')) {
                  return delegateToSchema({
                    schema: bookingSchema,
                    operation: 'query',
                    fieldName: 'customerById',
                    args,
                    context,
                    info,
                  });
                }

                throw new Error('invalid id');
              },
            },
            async nodes(_parent, _args, context, info) {
              const bookings = await delegateToSchema({
                schema: bookingSchema,
                operation: 'query',
                fieldName: 'bookings',
                context,
                info,
              });
              const properties = await delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'properties',
                context,
                info,
              });
              return [...bookings, ...properties];
            },
          },
        },
      });
    });

    describe('basic', () => {
      test('works with context', async () => {
        const propertyResult = await graphql(
          localPropertySchema,
          `
            query {
              contextTest(key: "test")
            }
          `,
          {},
          {
            test: 'Foo',
          },
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              contextTest(key: "test")
            }
          `,
          {},
          {
            test: 'Foo',
          },
        );

        expect(propertyResult).toEqual({
          data: {
            contextTest: '"Foo"',
          },
        });

        expect(stitchedResult).toEqual(propertyResult);
      });

      test('works with custom scalars', async () => {
        const propertyResult = await graphql(
          localPropertySchema,
          `
            query {
              dateTimeTest
              test1: jsonTest(input: { foo: "bar" })
              test2: jsonTest(input: 5)
              test3: jsonTest(input: "6")
            }
          `,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              dateTimeTest
              test1: jsonTest(input: { foo: "bar" })
              test2: jsonTest(input: 5)
              test3: jsonTest(input: "6")
            }
          `,
        );

        expect(propertyResult).toEqual({
          data: {
            dateTimeTest: '1987-09-25T12:00:00',
            test1: { foo: 'bar' },
            test2: 5,
            test3: '6',
          },
        });
        expect(stitchedResult).toEqual(propertyResult);
      });

      test('works with custom scalars', async () => {
        const scalarResult = await graphql(
          scalarSchema,
          `
            query {
              testingScalar(input: "test") {
                value
              }
              listTestingScalar(input: "test") {
                value
              }
            }
          `,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              testingScalar(input: "test") {
                value
              }
              listTestingScalar(input: "test") {
                value
              }
            }
          `,
        );

        expect(scalarResult).toEqual({
          data: {
            testingScalar: {
              value: 'test',
            },
            listTestingScalar: [
              {
                value: 'test',
              },
            ],
          },
        });
        expect(stitchedResult).toEqual(scalarResult);
      });

      test('works with custom enums', async () => {
        const enumResult = await graphql(
          enumSchema,
          `
            query {
              color(input: RED)
              numericEnum
              listNumericEnum
              numericEnumInfo: __type(name: "NumericEnum") {
                enumValues(includeDeprecated: true) {
                  name
                  description
                  isDeprecated
                  deprecationReason
                }
              }
              colorEnumInfo: __type(name: "Color") {
                enumValues {
                  name
                  description
                }
              }
              wrappedEnum {
                color
                numericEnum
              }
              unionWithEnum {
                ... on EnumWrapper {
                  color
                  numericEnum
                }
              }
            }
          `,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              color(input: RED)
              numericEnum
              listNumericEnum
              numericEnumInfo: __type(name: "NumericEnum") {
                enumValues(includeDeprecated: true) {
                  name
                  description
                  isDeprecated
                  deprecationReason
                }
              }
              colorEnumInfo: __type(name: "Color") {
                enumValues {
                  name
                  description
                }
              }
              wrappedEnum {
                color
                numericEnum
              }
              unionWithEnum {
                ... on EnumWrapper {
                  color
                  numericEnum
                }
              }
            }
          `,
        );

        expect(enumResult).toEqual({
          data: {
            color: 'RED',
            numericEnum: 'TEST',
            listNumericEnum: ['TEST'],
            numericEnumInfo: {
              enumValues: [
                {
                  description: 'A test description',
                  name: 'TEST',
                  isDeprecated: true,
                  deprecationReason: 'This is deprecated',
                },
              ],
            },
            colorEnumInfo: {
              enumValues: [
                {
                  description: 'A vivid color',
                  name: 'RED',
                },
              ],
            },
            wrappedEnum: {
              color: 'RED',
              numericEnum: 'TEST',
            },
            unionWithEnum: {
              color: 'RED',
              numericEnum: 'TEST',
            },
          },
        });
        expect(stitchedResult).toEqual(enumResult);
      });

      test('queries', async () => {
        const propertyFragment = `
propertyById(id: "p1") {
  id
  name
}
  `;
        const bookingFragment = `
bookingById(id: "b1") {
  id
  customer {
    name
  }
  startTime
  endTime
}
  `;

        const propertyResult = await graphql(
          localPropertySchema,
          `query { ${propertyFragment} }`,
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `query { ${bookingFragment} }`,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `query {
      ${propertyFragment}
      ${bookingFragment}
    }`,
        );
        expect(stitchedResult).toEqual({
          data: {
            ...propertyResult.data,
            ...bookingResult.data,
          },
        });
      });

      // Technically mutations are not idempotent, but they are in our test schemas
      test('mutations', async () => {
        const mutationFragment = `
      mutation Mutation($input: BookingInput!) {
        addBooking(input: $input) {
          id
          customer {
            name
          }
          startTime
          endTime
        }
      }
    `;
        const input = {
          propertyId: 'p1',
          customerId: 'c1',
          startTime: '2015-01-10',
          endTime: '2015-02-10',
        };

        const bookingResult = await graphql(
          localBookingSchema,
          mutationFragment,
          {},
          {},
          {
            input,
          },
        );
        const stitchedResult = await graphql(
          stitchedSchema,
          mutationFragment,
          {},
          {},
          {
            input,
          },
        );

        expect(stitchedResult).toEqual(bookingResult);
      });

      test('local subscriptions working in merged schema', (done) => {
        const mockNotification = {
          notifications: {
            text: 'Hello world',
          },
        };

        const subscription = parse(`
          subscription Subscription {
            notifications {
              text
            }
          }
        `);

        let notificationCnt = 0;
        subscribe(stitchedSchema, subscription)
          .then((results) => {
            forAwaitEach(
              results as AsyncIterable<ExecutionResult>,
              (result: ExecutionResult) => {
                expect(result).toHaveProperty('data');
                expect(result.data).toEqual(mockNotification);
                if (!notificationCnt++) {
                  done();
                }
              },
            ).catch(done);
          })
          .then(() =>
            subscriptionPubSub.publish(
              subscriptionPubSubTrigger,
              mockNotification,
            ),
          )
          .catch(done);
      });

      test('subscription errors are working correctly in merged schema', (done) => {
        const mockNotification = {
          notifications: {
            text: 'Hello world',
          },
        };

        const expectedResult = {
          data: {
            notifications: {
              text: 'Hello world',
              throwError: null,
            },
          } as any,
          errors: [
            {
              message: 'subscription field error',
              path: ['notifications', 'throwError'],
              locations: [
                {
                  line: 4,
                  column: 15,
                },
              ],
            },
          ],
        };

        const subscription = parse(`
          subscription Subscription {
            notifications {
              throwError
              text
            }
          }
        `);

        let notificationCnt = 0;
        subscribe(stitchedSchema, subscription)
          .then((results) => {
            forAwaitEach(
              results as AsyncIterable<ExecutionResult>,
              (result: ExecutionResult) => {
                expect(result).toHaveProperty('data');
                expect(result).toHaveProperty('errors');
                expect(result.errors).toHaveLength(1);
                expect(result.errors).toEqual(expectedResult.errors);
                expect(result.data).toEqual(expectedResult.data);
                if (!notificationCnt++) {
                  done();
                }
              },
            ).catch(done);
          })
          .then(() =>
            subscriptionPubSub.publish(
              subscriptionPubSubTrigger,
              mockNotification,
            ),
          )
          .catch(done);
      });

      test('links in queries', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              firstProperty: propertyById(id: "p2") {
                id
                name
                bookings {
                  id
                  textDescription
                  customer {
                    name
                  }
                }
              }
              secondProperty: propertyById(id: "p3") {
                id
                name
                bookings {
                  id
                  customer {
                    name
                  }
                }
              }
              booking: bookingById(id: "b1") {
                id
                customer {
                  name
                }
                property {
                  id
                  name
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            firstProperty: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  textDescription: 'Booking #b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                },
              ],
            },
            secondProperty: {
              id: 'p3',
              name: 'BedBugs - The Affordable Hostel',
              bookings: [],
            },
            booking: {
              id: 'b1',
              customer: {
                name: 'Exampler Customer',
              },

              property: {
                id: 'p1',
                name: 'Super great hotel',
              },
            },
          },
        });
      });

      test('interfaces', async () => {
        const query = `
          query {
            test1: interfaceTest(kind: ONE) {
              __typename
              kind
              testString
              ...on TestImpl1 {
                foo
              }
              ...on TestImpl2 {
                bar
              }
            }

            test2: interfaceTest(kind: TWO) {
              __typename
              kind
              testString
              ...on TestImpl1 {
                foo
              }
              ...on TestImpl2 {
                bar
              }
            }
          }
        `;
        const propertyResult = await graphql(localPropertySchema, query);
        const stitchedResult = await graphql(stitchedSchema, query);

        expect(propertyResult).toEqual({
          data: {
            test1: {
              __typename: 'TestImpl1',
              kind: 'ONE',
              testString: 'test',
              foo: 'foo',
            },
            test2: {
              __typename: 'TestImpl2',
              kind: 'TWO',
              testString: 'test',
              bar: 'bar',
            },
          },
        });

        expect(stitchedResult).toEqual(propertyResult);

        const delegateQuery = `
          query {
            withTypeName: delegateInterfaceTest {
              __typename
              kind
              testString
            }
            withoutTypeName: delegateInterfaceTest {
              kind
              testString
            }
          }
        `;

        const mergedDelegate = await graphql(stitchedSchema, delegateQuery);

        expect(mergedDelegate).toEqual({
          data: {
            withTypeName: {
              __typename: 'TestImpl1',
              kind: 'ONE',
              testString: 'test',
            },
            withoutTypeName: {
              kind: 'ONE',
              testString: 'test',
            },
          },
        });
      });

      test('unions', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              customerById(id: "c1") {
                ... on Person {
                  name
                }
                vehicle {
                  ... on Bike {
                    bikeType
                  }
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            customerById: {
              name: 'Exampler Customer',
              vehicle: { bikeType: 'MOUNTAIN' },
            },
          },
        });
      });

      test('unions with alias', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              customerById(id: "c1") {
                ... on Person {
                  name
                }
                v1: vehicle {
                  ... on Bike {
                    bikeType
                  }
                }
                v2: vehicle {
                  ... on Bike {
                    bikeType
                  }
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            customerById: {
              name: 'Exampler Customer',
              v1: { bikeType: 'MOUNTAIN' },
              v2: { bikeType: 'MOUNTAIN' },
            },
          },
        });
      });

      test('unions implementing interface', async () => {
        const query = `
          query {
            test1: unionTest(output: "Interface") {
              ... on TestInterface {
                kind
                testString
              }
              ... on TestImpl1 {
                foo
              }
              ... on UnionImpl {
                someField
              }
            }

            test2: unionTest(output: "OtherStuff") {
              ... on TestInterface {
                kind
                testString
              }
              ... on TestImpl1 {
                foo
              }
              ... on UnionImpl {
                someField
              }
            }
          }
        `;
        const stitchedResult = await graphql(stitchedSchema, query);
        expect(stitchedResult).toEqual({
          data: {
            test1: {
              kind: 'ONE',
              testString: 'test',
              foo: 'foo',
            },
            test2: {
              someField: 'Bar',
            },
          },
        });
      });

      test('interfaces spread from top level functions', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              first: customerById(id: "c1") {
                name
                ... on Node {
                  id
                }
              }

              second: customerById(id: "c1") {
                ...NodeFragment
              }
            }

            fragment NodeFragment on Node {
              id
              ... on Customer {
                name
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            first: {
              id: 'c1',
              name: 'Exampler Customer',
            },
            second: {
              id: 'c1',
              name: 'Exampler Customer',
            },
          },
        });
      });

      test('unions implementing an interface', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              customerById(id: "c1") {
                ... on Person {
                  name
                }
                vehicle {
                  ... on Node {
                    __typename
                    id
                  }
                }
                secondVehicle: vehicle {
                  ...NodeFragment
                }
              }
            }

            fragment NodeFragment on Node {
              id
              __typename
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            customerById: {
              name: 'Exampler Customer',
              vehicle: { __typename: 'Bike', id: 'v1' },
              secondVehicle: { __typename: 'Bike', id: 'v1' },
            },
          },
        });
      });

      test('input objects with default', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              one: defaultInputTest(input: {})
              two: defaultInputTest(input: { test: "Bar" })
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            one: 'Foo',
            two: 'Bar',
          },
        });
      });

      test('deep links', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p2") {
                id
                name
                bookings {
                  id
                  customer {
                    name
                  }
                  property {
                    id
                    name
                  }
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                  property: {
                    id: 'p2',
                    name: 'Another great hotel',
                  },
                },
              ],
            },
          },
        });
      });

      test('link arguments', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p1") {
                id
                name
                bookings(limit: 1) {
                  id
                  customer {
                    name
                  }
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p1',
              name: 'Super great hotel',
              bookings: [
                {
                  id: 'b1',
                  customer: {
                    name: 'Exampler Customer',
                  },
                },
              ],
            },
          },
        });
      });

      test('removes `isTypeOf` checks from proxied schemas', () => {
        const Booking = stitchedSchema.getType('Booking') as GraphQLObjectType;
        expect(Booking.isTypeOf).toBeUndefined();
      });

      test('should merge resolvers when passed an array of resolver objects', async () => {
        const Scalars = {
          TestScalar: new GraphQLScalarType({
            name: 'TestScalar',
            description: undefined,
            serialize: (value) => value,
            parseValue: (value) => value,
            parseLiteral: () => null,
          }),
        };
        const Enums = {
          NumericEnum: {
            TEST: 1,
          },
          Color: {
            RED: '#EA3232',
          },
        };
        const PropertyResolvers: IResolvers = {
          Property: {
            bookings: {
              selectionSet: '{ id }',
              resolve(parent, args, context, info) {
                return delegateToSchema({
                  schema: bookingSchema,
                  operation: 'query',
                  fieldName: 'bookingsByPropertyId',
                  args: {
                    propertyId: parent.id,
                    limit: args.limit ? args.limit : null,
                  },
                  context,
                  info,
                });
              },
            },
          },
        };
        const LinkResolvers: IResolvers = {
          Booking: {
            property: {
              selectionSet: '{ propertyId }',
              resolve(parent, _args, context, info) {
                return delegateToSchema({
                  schema: propertySchema,
                  operation: 'query',
                  fieldName: 'propertyById',
                  args: {
                    id: parent.propertyId,
                  },
                  context,
                  info,
                });
              },
            },
          },
        };
        const Query1 = {
          Query: {
            color() {
              return '#EA3232';
            },
            numericEnum() {
              return 1;
            },
          },
        };
        const Query2: IResolvers = {
          Query: {
            delegateInterfaceTest(_parent, _args, context, info) {
              return delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'interfaceTest',
                args: {
                  kind: 'ONE',
                },
                context,
                info,
              });
            },
            delegateArgumentTest(_parent, _args, context, info) {
              return delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'propertyById',
                args: {
                  id: 'p1',
                },
                context,
                info,
              });
            },
            linkTest() {
              return {
                test: 'test',
              };
            },
            node: {
              selectionSet: '{ id }',
              resolve(_parent, args, context, info) {
                if (args.id.startsWith('p')) {
                  return delegateToSchema({
                    schema: propertySchema,
                    operation: 'query',
                    fieldName: 'propertyById',
                    args,
                    context,
                    info,
                  });
                } else if (args.id.startsWith('b')) {
                  return delegateToSchema({
                    schema: bookingSchema,
                    operation: 'query',
                    fieldName: 'bookingById',
                    args,
                    context,
                    info,
                  });
                } else if (args.id.startsWith('c')) {
                  return delegateToSchema({
                    schema: bookingSchema,
                    operation: 'query',
                    fieldName: 'customerById',
                    args,
                    context,
                    info,
                  });
                }

                throw new Error('invalid id');
              },
            },
          },
        };

        const AsyncQuery: IResolvers = {
          Query: {
            async nodes(_parent, _args, context, info) {
              const bookings = await delegateToSchema({
                schema: bookingSchema,
                operation: 'query',
                fieldName: 'bookings',
                context,
                info,
              });
              const properties = await delegateToSchema({
                schema: propertySchema,
                operation: 'query',
                fieldName: 'properties',
                context,
                info,
              });
              return [...bookings, ...properties];
            },
          },
        };
        const schema = stitchSchemas({
          schemas: [
            propertySchema,
            bookingSchema,
            productSchema,
            scalarTest,
            enumSchema,
            linkSchema,
            loneExtend,
            localSubscriptionSchema,
          ],
          resolvers: [
            Scalars,
            Enums,
            PropertyResolvers,
            LinkResolvers,
            Query1,
            Query2,
            AsyncQuery,
          ],
        });

        const stitchedResult = await graphql(
          schema,
          `
            query {
              dateTimeTest
              test1: jsonTest(input: { foo: "bar" })
              test2: jsonTest(input: 5)
              test3: jsonTest(input: "6")
            }
          `,
        );
        const expected = {
          data: {
            dateTimeTest: '1987-09-25T12:00:00',
            test1: { foo: 'bar' },
            test2: 5,
            test3: '6',
          },
        };
        expect(stitchedResult).toEqual(expected);
      });
    });

    describe('fragments', () => {
      test('named', async () => {
        const propertyFragment = `
fragment PropertyFragment on Property {
  id
  name
  location {
    name
  }
}
    `;
        const bookingFragment = `
fragment BookingFragment on Booking {
  id
  customer {
    name
  }
  startTime
  endTime
}
    `;

        const propertyResult = await graphql(
          localPropertySchema,
          `
            ${propertyFragment}
            query {
              propertyById(id: "p1") {
                ...PropertyFragment
              }
            }
          `,
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `
            ${bookingFragment}
            query {
              bookingById(id: "b1") {
                ...BookingFragment
              }
            }
          `,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            ${bookingFragment}
            ${propertyFragment}

            query {
              propertyById(id: "p1") {
                ...PropertyFragment
              }
              bookingById(id: "b1") {
                ...BookingFragment
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            ...propertyResult.data,
            ...bookingResult.data,
          },
        });
      });

      test('inline', async () => {
        const propertyFragment = `
propertyById(id: "p1") {
  ... on Property {
    id
  }
  name
}
  `;
        const bookingFragment = `
bookingById(id: "b1") {
  id
  ... on Booking {
    customer {
      name
    }
    startTime
    endTime
  }
}
  `;

        const propertyResult = await graphql(
          localPropertySchema,
          `query { ${propertyFragment} }`,
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `query { ${bookingFragment} }`,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `query {
      ${propertyFragment}
      ${bookingFragment}
    }`,
        );

        expect(stitchedResult).toEqual({
          data: {
            ...propertyResult.data,
            ...bookingResult.data,
          },
        });
      });

      test('containing links', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p2") {
                id
                ... on Property {
                  name
                  bookings {
                    id
                    customer {
                      name
                    }
                    ...BookingFragment
                  }
                }
              }
            }

            fragment BookingFragment on Booking {
              property {
                ...PropertyFragment
              }
            }

            fragment PropertyFragment on Property {
              id
              name
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                  property: {
                    id: 'p2',
                    name: 'Another great hotel',
                  },
                },
              ],
            },
          },
        });
      });

      test('overlapping selections', async () => {
        const propertyFragment1 = `
fragment PropertyFragment1 on Property {
  id
  name
  location {
    name
  }
}
    `;
        const propertyFragment2 = `
fragment PropertyFragment2 on Property {
  id
  name
  location {
    name
  }
}
    `;
        const bookingFragment = `
fragment BookingFragment on Booking {
  id
  customer {
    name
  }
  startTime
  endTime
}
    `;

        const propertyResult = await graphql(
          localPropertySchema,
          `
            ${propertyFragment1}
            ${propertyFragment2}
            query {
              propertyById(id: "p1") {
                ...PropertyFragment1
                ...PropertyFragment2
              }
            }
          `,
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `
            ${bookingFragment}
            query {
              bookingById(id: "b1") {
                ...BookingFragment
              }
            }
          `,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `
            ${bookingFragment}
            ${propertyFragment1}
            ${propertyFragment2}

            query {
              propertyById(id: "p1") {
                ...PropertyFragment1
                ...PropertyFragment2
              }
              bookingById(id: "b1") {
                ...BookingFragment
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            ...propertyResult.data,
            ...bookingResult.data,
          },
        });
      });

      test('containing fragment on outer type', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p2") {
                id
                ... on Property {
                  name
                  ...BookingFragment1
                }
              }
            }

            fragment BookingFragment1 on Property {
              bookings {
                id
                property {
                  id
                  name
                }
              }
              ...BookingFragment2
            }

            fragment BookingFragment2 on Property {
              bookings {
                customer {
                  name
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                  property: {
                    id: 'p2',
                    name: 'Another great hotel',
                  },
                },
              ],
            },
          },
        });
      });

      test('containing links and overlapping fragments on relation', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p2") {
                id
                ... on Property {
                  name
                  ...BookingFragment1
                  ...BookingFragment2
                }
              }
            }

            fragment BookingFragment1 on Property {
              bookings {
                id
                property {
                  id
                  name
                }
              }
            }

            fragment BookingFragment2 on Property {
              bookings {
                customer {
                  name
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                  property: {
                    id: 'p2',
                    name: 'Another great hotel',
                  },
                },
              ],
            },
          },
        });
      });

      test('containing links and single fragment on relation', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p2") {
                id
                ... on Property {
                  name
                  ...BookingFragment
                }
              }
            }

            fragment BookingFragment on Property {
              bookings {
                id
                customer {
                  name
                }
                property {
                  id
                  name
                }
              }
            }
          `,
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p2',
              name: 'Another great hotel',
              bookings: [
                {
                  id: 'b4',
                  customer: {
                    name: 'Exampler Customer',
                  },
                  property: {
                    id: 'p2',
                    name: 'Another great hotel',
                  },
                },
              ],
            },
          },
        });
      });
    });

    describe('variables', () => {
      test('basic', async () => {
        const propertyFragment = `
          propertyById(id: $p1) {
            id
            name
          }
        `;
        const bookingFragment = `
          bookingById(id: $b1) {
            id
            customer {
              name
            }
            startTime
            endTime
          }
        `;

        const propertyResult = await graphql(
          localPropertySchema,
          `query($p1: ID!) { ${propertyFragment} }`,
          {},
          {},
          {
            p1: 'p1',
          },
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `query($b1: ID!) { ${bookingFragment} }`,
          {},
          {},
          {
            b1: 'b1',
          },
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `query($p1: ID!, $b1: ID!) {
        ${propertyFragment}
        ${bookingFragment}
      }`,
          {},
          {},
          {
            p1: 'p1',
            b1: 'b1',
          },
        );

        expect(stitchedResult).toEqual({
          data: {
            ...propertyResult.data,
            ...bookingResult.data,
          },
        });
      });

      test('in link selections', async () => {
        const stitchedResult = await graphql(
          stitchedSchema,
          `
            query($limit: Int) {
              propertyById(id: "p1") {
                id
                name
                ... on Property {
                  ...BookingFragment
                }
              }
            }

            fragment BookingFragment on Property {
              bookings(limit: $limit) {
                id
                customer {
                  name
                  ... on Person {
                    id
                  }
                }
              }
            }
          `,
          {},
          {},
          {
            limit: 1,
          },
        );

        expect(stitchedResult).toEqual({
          data: {
            propertyById: {
              id: 'p1',
              name: 'Super great hotel',
              bookings: [
                {
                  id: 'b1',
                  customer: {
                    name: 'Exampler Customer',
                    id: 'c1',
                  },
                },
              ],
            },
          },
        });
      });
    });

    describe('aliases', () => {
      test('aliases', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              property: propertyById(id: "p1") {
                id
                propertyId: id
                secondAlias: id
                firstReservation: bookings(limit: 1) {
                  id
                }
                reservations: bookings {
                  bookingId: id
                  user: customer {
                    customerId: id
                  }
                  hotel: property {
                    propertyId: id
                  }
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            property: {
              id: 'p1',
              propertyId: 'p1',
              secondAlias: 'p1',
              firstReservation: [
                {
                  id: 'b1',
                },
              ],
              reservations: [
                {
                  bookingId: 'b1',
                  user: {
                    customerId: 'c1',
                  },
                  hotel: {
                    propertyId: 'p1',
                  },
                },
                {
                  bookingId: 'b2',
                  hotel: {
                    propertyId: 'p1',
                  },
                  user: {
                    customerId: 'c2',
                  },
                },
                {
                  bookingId: 'b3',
                  hotel: {
                    propertyId: 'p1',
                  },
                  user: {
                    customerId: 'c3',
                  },
                },
              ],
            },
          },
        });
      });

      test('aliases subschema queries', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              customerById(id: "c1") {
                id
                firstBooking: bookings(limit: 1) {
                  id
                  property {
                    id
                  }
                }
                allBookings: bookings(limit: 10) {
                  id
                  property {
                    id
                  }
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            customerById: {
              id: 'c1',
              firstBooking: [
                {
                  id: 'b1',
                  property: {
                    id: 'p1',
                  },
                },
              ],
              allBookings: [
                {
                  id: 'b1',
                  property: {
                    id: 'p1',
                  },
                },
                {
                  id: 'b4',
                  property: {
                    id: 'p2',
                  },
                },
              ],
            },
          },
        });
      });
    });

    describe('errors', () => {
      test('root level', async () => {
        const propertyFragment = `
                errorTest
              `;
        const bookingFragment = `
          bookingById(id: "b1") {
            id
            customer {
              name
            }
            startTime
            endTime
          }
        `;

        const propertyResult = await graphql(
          localPropertySchema,
          `query {
                  ${propertyFragment}
                }`,
        );

        const bookingResult = await graphql(
          localBookingSchema,
          `query {
                  ${bookingFragment}
                }`,
        );

        const stitchedResult = await graphql(
          stitchedSchema,
          `query {
            ${propertyFragment}
            ${bookingFragment}
          }`,
        );
        expect(stitchedResult.data).toEqual({
          ...propertyResult.data,
          ...bookingResult.data,
        });
        expect(stitchedResult.errors.map(removeLocations)).toEqual(
          propertyResult.errors.map(removeLocations),
        );

        const stitchedResult2 = await graphql(
          stitchedSchema,
          `
                query {
                  errorTestNonNull
                  ${bookingFragment}
                }
              `,
        );

        expect(stitchedResult2.data).toBe(null);
        expect(stitchedResult2.errors.map(removeLocations)).toEqual([
          {
            message: 'Sample error non-null!',
            path: ['errorTestNonNull'],
          },
        ]);
      });

      test('nested errors', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p1") {
                error
                errorAlias: error
                bookings {
                  id
                  error
                  bookingErrorAlias: error
                }
              }
            }
          `,
        );

        expect(result.data).toEqual({
          propertyById: {
            bookings: [
              {
                bookingErrorAlias: null,
                error: null,
                id: 'b1',
              },
              {
                bookingErrorAlias: null,
                error: null,
                id: 'b2',
              },
              {
                bookingErrorAlias: null,
                error: null,
                id: 'b3',
              },
            ],
            error: null,
            errorAlias: null,
          },
        });

        const errorsWithoutLocations = result.errors.map(removeLocations);

        const expectedErrors: Array<any> = [
          {
            message: 'Property.error error',
            path: ['propertyById', 'error'],
          },
          {
            message: 'Property.error error',
            path: ['propertyById', 'errorAlias'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 0, 'error'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 0, 'bookingErrorAlias'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 1, 'error'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 1, 'bookingErrorAlias'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 2, 'error'],
          },
          {
            message: 'Booking.error error',
            path: ['propertyById', 'bookings', 2, 'bookingErrorAlias'],
          },
        ];

        expectedErrors[0].extensions = { code: 'SOME_CUSTOM_CODE' };
        expectedErrors[1].extensions = { code: 'SOME_CUSTOM_CODE' };

        expect(errorsWithoutLocations).toEqual(expectedErrors);
      });

      test(
        'should preserve custom error extensions from the original schema, ' +
          'when merging schemas',
        async () => {
          const propertyQuery = `
          query {
            properties(limit: 1) {
              error
            }
          }
        `;

          const propertyResult = await graphql(
            localPropertySchema,
            propertyQuery,
          );

          const stitchedResult = await graphql(stitchedSchema, propertyQuery);

          [propertyResult, stitchedResult].forEach((result) => {
            expect(result.errors).toBeDefined();
            expect(result.errors.length > 0).toBe(true);
            const error = result.errors[0];
            expect(error.extensions).toBeDefined();
            expect(error.extensions.code).toBe('SOME_CUSTOM_CODE');
          });
        },
      );
    });

    describe('types in schema extensions', () => {
      test('should parse descriptions on new types', () => {
        expect(stitchedSchema.getType('AnotherNewScalar').description).toBe(
          'Description of AnotherNewScalar.',
        );

        expect(stitchedSchema.getType('TestingScalar').description).toBe(
          'A type that uses TestScalar.',
        );

        expect(stitchedSchema.getType('Color').description).toBe(
          'A type that uses an Enum.',
        );

        expect(stitchedSchema.getType('NumericEnum').description).toBe(
          'A type that uses an Enum with a numeric constant.',
        );

        expect(stitchedSchema.getType('LinkType').description).toBe(
          'A new type linking the Property type.',
        );

        expect(stitchedSchema.getType('LinkType').description).toBe(
          'A new type linking the Property type.',
        );
      });

      test('should parse descriptions on new fields', () => {
        const Query = stitchedSchema.getQueryType();
        expect(Query.getFields().linkTest.description).toBe(
          'A new field on the root query.',
        );

        const Booking = stitchedSchema.getType('Booking') as GraphQLObjectType;
        expect(Booking.getFields().property.description).toBe(
          'The property of the booking.',
        );

        const Property = stitchedSchema.getType(
          'Property',
        ) as GraphQLObjectType;
        const bookingsField = Property.getFields().bookings;
        expect(bookingsField.description).toBe('A list of bookings.');
        expect(bookingsField.args[0].description).toBe(
          'The maximum number of bookings to retrieve.',
        );
      });

      test('should allow defining new types in link type', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              linkTest {
                test
                property {
                  id
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            linkTest: {
              test: 'test',
              property: {
                id: 'p1',
              },
            },
          },
        });
      });
    });

    describe('merge info defined interfaces', () => {
      test('inline fragments on existing types in subschema', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query($pid: ID!, $bid: ID!) {
              property: node(id: $pid) {
                id
                ... on Property {
                  name
                }
              }
              booking: node(id: $bid) {
                id
                ... on Booking {
                  startTime
                  endTime
                }
              }
            }
          `,
          {},
          {},
          {
            pid: 'p1',
            bid: 'b1',
          },
        );

        expect(result).toEqual({
          data: {
            property: {
              id: 'p1',
              name: 'Super great hotel',
            },
            booking: {
              id: 'b1',
              startTime: '2016-05-04',
              endTime: '2016-06-03',
            },
          },
        });
      });

      test('inline fragments on non-compatible sub schema types', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query($bid: ID!) {
              node(id: $bid) {
                __typename
                id
                ... on Property {
                  name
                }
                ... on Booking {
                  startTime
                  endTime
                }
                ... on Customer {
                  name
                }
              }
            }
          `,
          {},
          {},
          {
            bid: 'b1',
          },
        );

        expect(result).toEqual({
          data: {
            node: {
              __typename: 'Booking',
              id: 'b1',
              startTime: '2016-05-04',
              endTime: '2016-06-03',
            },
          },
        });
      });

      test('fragments on non-compatible sub schema types', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query($bid: ID!) {
              node(id: $bid) {
                __typename
                id
                ...PropertyFragment
                ...BookingFragment
                ...CustomerFragment
              }
            }

            fragment PropertyFragment on Property {
              name
            }

            fragment BookingFragment on Booking {
              startTime
              endTime
            }

            fragment CustomerFragment on Customer {
              name
            }
          `,
          {},
          {},
          {
            bid: 'b1',
          },
        );

        expect(result).toEqual({
          data: {
            node: {
              __typename: 'Booking',
              id: 'b1',
              startTime: '2016-05-04',
              endTime: '2016-06-03',
            },
          },
        });
      });

      test('fragments on interfaces in merged schema', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query($bid: ID!) {
              node(id: $bid) {
                ...NodeFragment
              }
            }

            fragment NodeFragment on Node {
              id
              ... on Property {
                name
              }
              ... on Booking {
                startTime
                endTime
              }
            }
          `,
          {},
          {},
          {
            bid: 'b1',
          },
        );

        expect(result).toEqual({
          data: {
            node: {
              id: 'b1',
              startTime: '2016-05-04',
              endTime: '2016-06-03',
            },
          },
        });
      });

      test('multi-interface filter', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              products {
                id
                __typename
                ... on Sellable {
                  price
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            products: [
              {
                id: 'pd1',
                __typename: 'SimpleProduct',
                price: 100,
              },
              {
                id: 'pd2',
                __typename: 'DownloadableProduct',
              },
            ],
          },
        });
      });

      test('interface extensions', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              products {
                id
                __typename
                ... on Downloadable {
                  filesize
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            products: [
              {
                id: 'pd1',
                __typename: 'SimpleProduct',
              },
              {
                id: 'pd2',
                __typename: 'DownloadableProduct',
                filesize: 1024,
              },
            ],
          },
        });
      });

      test('arbitrary transforms that return interfaces', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              nodes {
                id
                ... on Property {
                  name
                }
                ... on Booking {
                  startTime
                  endTime
                }
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            nodes: [
              {
                id: 'b1',
                startTime: '2016-05-04',
                endTime: '2016-06-03',
              },
              {
                id: 'b2',
                startTime: '2016-06-04',
                endTime: '2016-07-03',
              },
              {
                id: 'b3',
                startTime: '2016-08-04',
                endTime: '2016-09-03',
              },
              {
                id: 'b4',
                startTime: '2016-10-04',
                endTime: '2016-10-03',
              },
              {
                id: 'p1',
                name: 'Super great hotel',
              },
              {
                id: 'p2',
                name: 'Another great hotel',
              },
              {
                id: 'p3',
                name: 'BedBugs - The Affordable Hostel',
              },
            ],
          },
        });
      });
    });

    describe('schema directives', () => {
      test('should work with schema directives', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              propertyById(id: "p1") {
                someField
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            propertyById: {
              someField: 'SOMEFIELD',
            },
          },
        });
      });
    });

    describe('regression', () => {
      test('should not pass extra arguments to delegates', async () => {
        const result = await graphql(
          stitchedSchema,
          `
            query {
              delegateArgumentTest(arbitraryArg: 5) {
                id
              }
            }
          `,
        );

        expect(result).toEqual({
          data: {
            delegateArgumentTest: {
              id: 'p1',
            },
          },
        });
      });

      test('defaultMergedResolver should work with aliases if parent merged resolver is manually overwritten', async () => {
        // Source: https://github.com/apollographql/graphql-tools/issues/967
        const typeDefs = `
            type Query {
              book: Book
            }
            type Book {
              category: String!
            }
          `;
        let schema = makeExecutableSchema({ typeDefs });

        const resolvers = {
          Query: {
            book: () => ({ category: 'Test' }),
          },
        };

        schema = stitchSchemas({
          schemas: [schema],
          resolvers,
        });

        const result = await graphql(schema, '{ book { cat: category } }');

        expect(result.data.book.cat).toBe('Test');
      });
    });

    describe('deprecation', () => {
      test('should retain deprecation information', () => {
        const typeDefs = `
          type Query {
            book: Book
          }
          type Book {
            category: String! @deprecated(reason: "yolo")
          }
        `;

        const query = `query {
          book {
            category
          }
        }`;

        const resolvers = {
          Query: {
            book: () => ({ category: 'Test' }),
          },
        };

        const schema = stitchSchemas({
          schemas: [propertySchema, typeDefs],
          resolvers,
        });

        const deprecatedUsages = findDeprecatedUsages(schema, parse(query));
        expect(deprecatedUsages.length).toBe(1);
        expect(
          deprecatedUsages.find(
            (error) =>
              error.message.match(/deprecated/g) != null &&
              error.message.match(/yolo/g) != null,
          ),
        ).toBeDefined();
      });
    });
  });

  describe('scalars without executable schema', () => {
    test('can merge and query schema', async () => {
      const BookSchema = `
        type Book {
          name: String
        }
      `;

      const AuthorSchema = `
        type Query {
          book: Book
        }

        type Author {
          name: String
        }

        type Book {
          author: Author
        }
      `;

      const resolvers = {
        Query: {
          book: () => ({
            author: {
              name: 'JRR Tolkien',
            },
          }),
        },
      };

      const result = await graphql(
        stitchSchemas({ schemas: [BookSchema, AuthorSchema], resolvers }),
        `
          query {
            book {
              author {
                name
              }
            }
          }
        `,
        {},
        {
          test: 'Foo',
        },
      );

      expect(result).toEqual({
        data: {
          book: {
            author: {
              name: 'JRR Tolkien',
            },
          },
        },
      });
    });
  });

  describe('new root type name', () => {
    test('works', async () => {
      let bookSchema = makeExecutableSchema({
        typeDefs: `
          type Query {
            book: Book
          }
          type Book {
            name: String
          }
        `,
      });

      let movieSchema = makeExecutableSchema({
        typeDefs: `
          type Query {
            movie: Movie
          }

          type Movie {
            name: String
          }
        `,
      });

      bookSchema = addMocksToSchema({ schema: bookSchema });
      movieSchema = addMocksToSchema({ schema: movieSchema });

      const stitchedSchema = stitchSchemas({
        schemas: [bookSchema, movieSchema],
        typeDefs: `
          schema {
            query: RootQuery
          }
        `,
      });

      const result = await graphql(
        stitchedSchema,
        `
          query {
            ... on RootQuery {
              book {
                name
              }
            }
          }
        `,
      );

      expect(result).toEqual({
        data: {
          book: {
            name: 'Hello World',
          },
        },
      });
    });
  });

  describe('stitching from existing interfaces', () => {
    test('works', async () => {
      const STOCK_RECORDS = {
        1: {
          id: 1,
          stock: 100,
        },
      };

      const stockSchema = makeExecutableSchema({
        typeDefs: `
          type StockRecord {
            id: ID!
            stock: Int!
          }
          type Query {
            stockRecord(id: ID!): StockRecord
          }
        `,
        resolvers: {
          Query: {
            stockRecord: (_, { id }) => STOCK_RECORDS[id],
          },
        },
      });

      const PRODUCTS = [
        {
          id: 1,
          title: "T-Shirt",
        },
      ];

      const COLLECTIONS = [
        {
          id: 1,
          name: "Apparel",
          products: PRODUCTS,
        },
      ];

      const productSchema = makeExecutableSchema({
        typeDefs: `
          interface IProduct {
            id: ID!
            title: String!
          }
          type Product implements IProduct {
            id: ID!
            title: String!
          }
          type Collection {
            id: ID!
            name: String!
            products: [Product!]!
          }
          type Query {
            collections: [Collection!]!
          }
        `,
        resolvers: {
          Query: {
            collections: () => COLLECTIONS,
          },
        },
      });

      const stitchedSchema = stitchSchemas({
        inheritResolversFromInterfaces: true,
        subschemas: [stockSchema, productSchema],
        resolvers: {
          IProduct: {
            stockRecord: {
              selectionSet: `{ id } `,
              resolve: (obj, _args, _context, info) => delegateToSchema({
                schema: stockSchema,
                operation: "query",
                fieldName: "stockRecord",
                args: { id: obj.id },
                info,
              }),
            },
          },
        },
        typeDefs: `
          extend interface IProduct {
            stockRecord: StockRecord
          }
          extend type Product {
            stockRecord: StockRecord
          }
        `,
      });

      const concreteResult = await graphql(
        stitchedSchema,
        `
          query {
            collections {
              name
              products {
                title
                stockRecord {
                  stock
                }
              }
            }
          }
        `,
      );

      expect(concreteResult).toEqual({
        data: {
          collections: [{
            name: 'Apparel',
            products: [{
              title: 'T-Shirt',
              stockRecord: {
                stock: 100,
              }
            }]
          }]
        }
      });

      const fragmentResult = await graphql(
        stitchedSchema,
        `
          query {
              collections {
              name
              products {
                ...InterfaceFragment
              }
            }
          }

          fragment InterfaceFragment on IProduct {
            title
            stockRecord {
              stock
            }
          }
        `,
      );

      expect(fragmentResult).toEqual({
        data: {
          collections: [{
            name: 'Apparel',
            products: [{
              title: 'T-Shirt',
              stockRecord: {
                stock: 100
              }
            }]
          }]
        }
      });

      const interfaceResult = await graphql(
        stitchedSchema,
        `
          query {
            collections {
              name
              products {
                ... on IProduct {
                  title
                  stockRecord {
                    stock
                  }
                }
              }
            }
          }
        `,
      );

      expect(interfaceResult).toEqual({
        data: {
          collections: [{
            name: 'Apparel',
            products: [{
              title: 'T-Shirt',
              stockRecord: {
                stock: 100
              }
            }]
          }]
        }
      });
    });
  });
});
