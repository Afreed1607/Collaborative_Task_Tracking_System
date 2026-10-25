const SwaggerParser = require('@apidevtools/swagger-parser');

SwaggerParser.validate('./openapi.json')
  .then((api) => console.log(`Validated OpenAPI ${api.openapi}`))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
