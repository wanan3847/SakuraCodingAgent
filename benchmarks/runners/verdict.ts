/** Judge the assistant's actual answer, never the task prompt or echoed tool output. */
export function readOnlyVerdict(input:{diff?:string;answer:string;findingPattern:string;locationPattern:string}):boolean {
 return !input.diff && Boolean(input.answer.trim()) && new RegExp(input.findingPattern,"i").test(input.answer) && new RegExp(input.locationPattern,"i").test(input.answer);
}
