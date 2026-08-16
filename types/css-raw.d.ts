// Vite ?raw 导入的类型声明（内容脚本内嵌设置页 CSS 字符串）
declare module '*.css?raw' {
  const content: string;
  export default content;
}
