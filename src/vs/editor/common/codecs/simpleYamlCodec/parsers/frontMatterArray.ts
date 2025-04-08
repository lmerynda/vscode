/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NewLine } from '../../linesCodec/tokens/newLine.js';
import { PartialFrontMatterValue } from './frontMatterValue.js';
import { FrontMatterArray } from '../tokens/frontMatterArray.js';
import { assertDefined } from '../../../../../base/common/types.js';
import { FrontMatterValueToken } from '../tokens/frontMatterToken.js';
import { TSimpleDecoderToken } from '../../simpleCodec/simpleDecoder.js';
import { CarriageReturn } from '../../linesCodec/tokens/carriageReturn.js';
import { DoubleQuote, LeftBracket, Quote, RightBracket, Space, Tab, Word } from '../../simpleCodec/tokens/index.js';
import { assertNotConsumed, ParserBase, TAcceptTokenResult } from '../../simpleCodec/parserBase.js';
import { assert } from '../../../../../base/common/assert.js';

/**
 * TODO: @legomushroom
 */
// TODO: @legomushroom - any other tokens allowed?
// TODO: @legomushroom - use common constant
const ALLOWED_TOKENS = [
	Space, Tab, CarriageReturn,
];

/**
 * TODO: @legomushroom
 */
// TODO: @legomushroom - any other tokens allowed?
const START_VALUE_TOKENS = [
	Word, Quote, DoubleQuote, LeftBracket, RightBracket,
];

// /**
//  * TODO: @legomushroom
//  */
// type TArrayItem = LeftBracket | FrontMatterValueToken | RightBracket;

/**
 * TODO: @legomushroom
 */
export class PartialFrontMatterArray extends ParserBase<TSimpleDecoderToken, PartialFrontMatterArray | FrontMatterArray> {
	/**
	 * TODO: @legomushroom
	 */
	private currentValueParser?: PartialFrontMatterValue;

	constructor(
		private readonly startToken: LeftBracket,
	) {
		super([startToken]);
	}

	@assertNotConsumed
	public accept(token: TSimpleDecoderToken): TAcceptTokenResult<PartialFrontMatterArray | FrontMatterArray> {
		if (this.currentValueParser !== undefined) {
			const acceptResult = this.currentValueParser.accept(token);
			const { result, wasTokenConsumed } = acceptResult;

			if (result === 'failure') {
				this.isConsumed = true;

				return {
					result: 'failure',
					wasTokenConsumed,
				};
			}

			const { nextParser } = acceptResult;

			if (nextParser instanceof FrontMatterValueToken) {
				this.currentTokens.push(nextParser);
				delete this.currentValueParser;

				return {
					result: 'success',
					nextParser: this,
					wasTokenConsumed,
				};
			}

			this.currentValueParser = nextParser;
			return {
				result: 'success',
				nextParser: this,
				wasTokenConsumed,
			};
		}

		if (token instanceof RightBracket) {
			// sanity check in case this block moves around
			// to a different place in the code
			assert(
				this.currentValueParser === undefined,
				`Unexpected end of array. Last value is not finished.`,
			);

			this.currentTokens.push(token);

			return {
				result: 'success',
				nextParser: this.asArrayToken(),
				wasTokenConsumed: true,
			};
		}

		// iterate until a a value start token is found

	}

	/**
		 * TODO: @legomushroom
		 */
	public asArrayToken(): FrontMatterArray {
		assertDefined(
			this.endToken,
			`No matching end bracket found.`,
		);

		const middleTokens: FrontMatterValueToken[] = [];
		for (const currentToken of this.currentTokens) {
			if (currentToken instanceof FrontMatterValueToken) {
				middleTokens.push(currentToken);
			}
		}

		return new FrontMatterArray([
			this.startToken,
			...middleTokens,
			this.endToken,
		]);
	}
}
