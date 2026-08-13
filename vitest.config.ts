import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'unit',
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
