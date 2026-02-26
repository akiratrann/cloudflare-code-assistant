import { test, expect } from '@playwright/test'

test.describe('Cloudflare Code Assistant UI', () => {
  test('renders layout chrome', async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByText('Cloudflare Code Assistant', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Workers AI', { exact: true })).toBeVisible()
    await expect(page.getByText('Projects', { exact: true })).toBeVisible()
    await expect(page.getByText('Chats', { exact: true })).toBeVisible()
    await expect(page.getByText('Files', { exact: true })).toBeVisible()
  })

  test('accepts user input and shows it in the chat', async ({ page }) => {
    await page.goto('/')

    const textarea = page.getByPlaceholder('Ask about your project or paste code…')
    await textarea.fill('Test message from Playwright')
    await page.getByRole('button', { name: /send/i }).click()

    await expect(page.getByText('You').first()).toBeVisible()
    await expect(page.getByText('Test message from Playwright')).toBeVisible()
  })

  test('handles Worker offline scenario gracefully', async ({ page }) => {
    await page.route('**/api/chat', async (route) => {
      await route.fulfill({
        status: 500,
        body: 'Simulated network error',
      })
    })

    await page.goto('/')

    const textarea = page.getByPlaceholder('Ask about your project or paste code…')
    await textarea.fill('Will this fail?')
    await page.getByRole('button', { name: /send/i }).click()

    await expect(
      page.getByText('There was an error talking to the Cloudflare Worker. Is it running locally?'),
    ).toBeVisible()
  })
})

