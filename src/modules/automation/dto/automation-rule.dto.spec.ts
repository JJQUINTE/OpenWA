import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateAutomationRuleDto } from './automation-rule.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

describe('UpdateAutomationRuleDto', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const through = (value: object): Promise<unknown> =>
    pipe.transform(value, { type: 'body', metatype: UpdateAutomationRuleDto });

  // These four columns are NOT NULL: a null that got past validation reached save() and answered 500.
  it.each(['name', 'replyText', 'cooldownSeconds', 'enabled'])('rejects %s: null with a 400', async key => {
    await expect(through({ [key]: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts an empty body and conditions: null, which clears the conditions', async () => {
    await expect(through({})).resolves.toEqual({});
    await expect(through({ conditions: null })).resolves.toEqual({ conditions: null });
  });
});
