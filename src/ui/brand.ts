import {Theme,type ThemeColor,type ThemeBg} from "@earendil-works/pi-coding-agent";
import {truncateToWidth} from "@earendil-works/pi-tui";
const backgrounds=new Set<ThemeBg>(["selectedBg","searchMatchBg","userMessageBg","customMessageBg","toolPendingBg","toolSuccessBg","toolErrorBg"]);
/** Empty native theme slots use the terminal defaults; no persistent theme setting is changed. */
export function plainTheme(source:Theme):Theme {
 const tokens=Object.keys(source.colors);
 const fg=Object.fromEntries(tokens.filter(token=>!backgrounds.has(token as ThemeBg)).map(token=>[token,""])) as Record<ThemeColor,string>;
 const bg=Object.fromEntries(tokens.filter(token=>backgrounds.has(token as ThemeBg)).map(token=>[token,""])) as Record<ThemeBg,string>;
 return new Theme(fg,bg,"256color",{name:"sakura-no-color",appearance:source.appearance});
}
export function brandHeader(width:number,emoji=true):string[] {
 // 只有品牌行。命令提示、模型和上下文都在 Pi 原生底栏里，不重复画一遍。
 return [truncateToWidth(`${emoji?"🌸 ":""}Sakura Coding Agent`,Math.max(1,width))];
}
