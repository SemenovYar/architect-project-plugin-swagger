const _ = require('lodash');

const getIn = _.get;

const toCamelCase = (str) => {
  return _.upperFirst(_.camelCase(str));
};

const codeGenConfig = {
  typePropLineBreak: 3, // true | false | 2 | 3...
};

const getJoinSeparator = (length) => {
  const maxLength = JSON.parse(codeGenConfig.typePropLineBreak);

  if (maxLength) {
    return length <= maxLength ? undefined : ',\n';
  }
};

const typeCreatorMap = {
  object: createTypeForObject,
  array: createTypeForArray,
  enum: createTypeForEnum,
};

function createTypeForEnum({ field, schema, typesMap, overrideFieldTypesMap }) {
  return schema.enum.map((el) => `'${el}'`).join('|');
}

function createTypeForObject({ field, schema, typesMap, overrideFieldTypesMap }) {
  let resultType = [];

  if (schema['$ref']) {
    const refSplitted = schema['$ref'].split('/');
    resultType.push(refSplitted[refSplitted.length - 1]);
  }

  if (schema.properties) {
    const typeProperties = [];
    Object.entries(schema.properties).forEach(([field, fieldSchema]) => {
      const typeProp = createTypeByTypeMap({ field, schema: fieldSchema, typesMap, overrideFieldTypesMap });
      const typeSuffix = fieldSchema.nullable ? '| null' : ''; // возможно тут можно ставить '?' перед самим полем
      typeProperties.push(`${field}: ${typeProp}${typeSuffix}`);
    });
    const joinSeparator = getJoinSeparator(typeProperties.length);
    const startEnd = joinSeparator ? '\n' : '';
    resultType.push(`{${startEnd}${typeProperties.join(joinSeparator)}${startEnd}}`);
  }

  if (schema.allOf) {
    const allOfTypes = schema.allOf.map((el) => createTypeByTypeMap({ schema: el, typesMap, overrideFieldTypesMap }));
    resultType.push(allOfTypes.join(' & '));
  }

  if (schema.oneOf) {
    const oneOfTypes = schema.oneOf.map((el) => createTypeByTypeMap({ schema: el, typesMap, overrideFieldTypesMap }));
    resultType.push(oneOfTypes.join(' | '));
  }

  if (schema.anyOf) {
    let anyOfTypes = schema.anyOf.map((el) => createTypeByTypeMap({ schema: el, typesMap, overrideFieldTypesMap }));
    anyOfTypes = anyOfTypes.join(' & ');
    resultType.push(`Partial<${anyOfTypes}>`);
  }

  return resultType.join('&');
}

function createTypeForArray({ field, schema, typesMap, overrideFieldTypesMap }) {
  const typeItem = createTypeByTypeMap({ field, schema: schema.items, typesMap, overrideFieldTypesMap });
  return `Array<${typeItem}>`;
}

function createTypeByTypeMap({ field, schema, typesMap, overrideFieldTypesMap }) {
  let type = schema.type;
  const isObject = schema['$ref'] || schema['properties'] || schema['allOf'] || schema['oneOf'] || schema['anyOf'];
  const isArray = schema.type === 'array';
  const isEnum = schema['enum'];
  type = isObject ? 'object' : type;
  type = isEnum ? 'enum' : type;

  if (field && overrideFieldTypesMap[field]) {
    return overrideFieldTypesMap[field];
  }

  const noHandler = !isArray && !isObject && !isEnum;
  const schemaHasOnlyType = schema.type && Object.keys(schema).length === 1;
  if (schemaHasOnlyType || noHandler) {
    return typesMap[schema.type] || typesMap['*'];
  }

  return typeCreatorMap[type]({ schema, typesMap, overrideFieldTypesMap });
}

function createTypesFromSchemesBySwaggerSpec({ swaggerSpec, typesMap, overrideFieldTypesMap }) {
  const schemas = swaggerSpec.components.schemas;
  const typeCodes = [];
  const typeNames = [];

  Object.entries(schemas).forEach(([name, schema]) => {
    let resultType = createTypeByTypeMap({ schema, typesMap, overrideFieldTypesMap });
    resultType = `export type ${name} = ${resultType}`;
    typeNames.push(name);
    typeCodes.push(resultType);
  });

  return { typeCodes, typeNames };
}

const createTypesForRequestMethod = ({ method, URLGetterName, methodInfo, typesMap, overrideFieldTypesMap }) => {
  let result = {};
  const nameParamsMap = {};

  let fieldsPath = [];
  let fieldsQuery = [];
  const fieldsMap = {
    query: fieldsQuery,
    path: fieldsPath,
  };

  if (methodInfo.parameters) {
    methodInfo.parameters.forEach((param) => {
      const field = param.name;
      const type = createTypeByTypeMap({ schema: param.schema, field, typesMap, overrideFieldTypesMap });
      const formattedField = field.replace(/[^\w]+/g, '');
      const fieldSuffix = param.required ? '' : '?';
      fieldsMap[param.in].push(`${formattedField}${fieldSuffix}: ${type}`);
    });
  }

  if (methodInfo.requestBody) {
    const schema = methodInfo.requestBody.content['application/json'].schema;
    const type = createTypeByTypeMap({ schema, typesMap, overrideFieldTypesMap });
    let typeName = toCamelCase([URLGetterName, 'data', 'params']);
    result.data = `export type ${typeName} = ${type}`;
    nameParamsMap.data = typeName;
  }

  const responseSchema = getIn(methodInfo, `responses.200.content['application/json'].schema`);
  if (responseSchema) {
    const type = createTypeByTypeMap({ schema: responseSchema, typesMap, overrideFieldTypesMap });
    let typeName = toCamelCase([URLGetterName, 'result']);
    result.result = `export type ${typeName} = ${type}`;
    nameParamsMap.result = typeName;
  }

  if (method === 'post') {
    delete fieldsMap.query;
  }

  const createType = ({ typeName, fields }) => `export type ${typeName} = {\n${fields}\n};`;

  result = Object.entries(fieldsMap).reduce((acc, [paramIn, fields]) => {
    if (fields.length) {
      const typeNameSuffix = paramIn === 'path' ? 'url' : paramIn;
      let typeName = toCamelCase([URLGetterName, typeNameSuffix, 'params']);
      nameParamsMap[paramIn] = typeName;
      fields = fields.join(',');
      acc[paramIn] = createType({ typeName, fields });
    }
    return acc;
  }, result);

  const params = Object.entries(nameParamsMap).reduce((acc, [kindOfParam, type]) => {
    if (kindOfParam === 'path') {
      kindOfParam = 'urlParams';
    }
    if (kindOfParam === 'result') {
      return acc;
    }
    acc.push(`${kindOfParam}: ${type}`);
    return acc;
  }, []);

  const nameTypeParams = toCamelCase([URLGetterName, 'params']);
  result.params = `export type ${nameTypeParams} = {\n${params.join(',')}\n}`;
  nameParamsMap.params = nameTypeParams;

  return { codeTypeMap: result, nameParamsMap }; // {['query' | 'path' | 'data' | 'result' | 'params']: 'code'}
};

const templateLocationToParams = (locationAsArray) => {
  const params = [];
  locationAsArray.forEach((el) => {
    if (el[0] === '{') {
      params.push(el.slice(1, -1));
    }
  });
  return { code: params.join(), params };
};

const templateLocationToInterpolateStr = ({ locationAsArray, pathPrefix }) => {
  const nodes = [pathPrefix];
  locationAsArray.forEach((el) => {
    nodes.push(el[0] === '{' ? `\${${el.slice(1, -1)}}` : el);
  });
  return `\`${nodes.join('/')}\``;
};

const templateURLGetter = ({ method, locationAsArray, pathPrefix }) => {
  const locationAsArrayWithoutParams = locationAsArray.map((el) => (el[0] === '{' ? ['by', el] : el));
  const locationAsCamelCase = toCamelCase(locationAsArrayWithoutParams);
  const interpolateLocation = templateLocationToInterpolateStr({ locationAsArray, pathPrefix });
  let { params: urlParams, code: urlParamsCode } = templateLocationToParams(locationAsArray);
  urlParamsCode = urlParamsCode.length ? `{${urlParamsCode}}` : '';
  const URLGetterName = `${method}${locationAsCamelCase}`;
  const code = `export const ${URLGetterName} = (${urlParamsCode}) => ${interpolateLocation}`;
  return { code, URLGetterName, urlParamsCode, urlParams };
};

const templateRequestFunction = ({
  URLGetterName,
  method,
  urlParamsCode,
  methodInfo,
  typesMap,
  overrideFieldTypesMap,
}) => {
  const urlParams = urlParamsCode ? 'urlParams' : '';

  const { codeTypeMap, nameParamsMap } = createTypesForRequestMethod({
    method,
    URLGetterName,
    methodInfo,
    typesMap,
    overrideFieldTypesMap,
  });

  const filterParams = (el) => {
    el = el === 'urlParams' ? 'path' : el;
    return el && codeTypeMap[el];
  };

  const getRequestParamsMap = {
    get: () => [urlParams, 'query'].filter(filterParams),
    post: () => [urlParams, 'data'].filter(filterParams),
    put: () => [urlParams, 'data'].filter(filterParams),
    patch: () => [urlParams, 'data'].filter(filterParams),
    delete: () => [urlParams].filter(filterParams),
  };
  const params = getRequestParamsMap[method]();

  return {
    params,
    paramsCode: params.length ? `{${params}}` : '',
    paramsWithTypeCode: params.length ? `{${params}}: ${nameParamsMap.params}` : '',
    typeParamsNamesMap: nameParamsMap,
    typeParamsMap: codeTypeMap,
  };
};

const createEndpointsBySwaggerSpec = ({ swaggerSpec, typesMap, overrideFieldTypesMap, prefixCountNode = 0 }) => {
  const endpoints = [];
  let pathPrefix = '';

  try {
    Object.entries(swaggerSpec.paths).forEach(([path, requestMethods], i) => {
      const pathSplitted = path.split('/');
      if (i === 0) {
        pathPrefix = pathSplitted.slice(0, prefixCountNode + 1).join('/');
      }
      const locationAsArray = pathSplitted.slice(prefixCountNode + 1);

      Object.entries(requestMethods).forEach(([method, methodInfo]) => {
        const urlGetter = templateURLGetter({ method, locationAsArray, pathPrefix });
        const requestFunction = templateRequestFunction({
          overrideFieldTypesMap,
          typesMap,
          methodInfo,
          URLGetterName: urlGetter.URLGetterName,
          urlParamsCode: urlGetter.urlParamsCode,
          method,
        });

        endpoints.push({
          swagger: methodInfo,
          method,
          URLGetter: {
            name: urlGetter.URLGetterName,
            params: urlGetter.urlParams,
            paramsCode: urlGetter.urlParamsCode,
            code: urlGetter.code,
          },
          path,
          requestFunction,
        });
      });
    });
  } catch (e) {
    console.error('Failed to create endpoints: \n', e);
  }

  return { endpoints, pathPrefix };
};

module.exports = {
  createEndpointsBySwaggerSpec,
  createTypesFromSchemesBySwaggerSpec,
};
