// 注册测试 loader（与具体测试文件解耦：node --import ./tests/register.mjs）
import { register } from 'node:module'

register(new URL('./ts-loader.mjs', import.meta.url))
