import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

export interface ContractValidationSuccess<T> {
  success: true;
  data: T;
  errors: [];
}

export interface ContractValidationFailure {
  success: false;
  errors: ErrorObject[];
}

export type ContractValidationResult<T> = ContractValidationSuccess<T> | ContractValidationFailure;

export function createContractValidator<T>(schema: object): (value: unknown) => ContractValidationResult<T> {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  return (value: unknown) => {
    if (validate(value)) return { success: true, data: value as T, errors: [] };
    return { success: false, errors: [...(validate.errors ?? [])] };
  };
}
