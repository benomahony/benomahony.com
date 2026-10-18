-- Loaded by Neovim's 'exrc' when started in this repo.

-- :NewPost [title] opens content/blog/<slug>.smd with the `post` snippet expanded.
local blog = vim.fn.getcwd() .. "/content/blog"

local function new_post(title)
  local slug = title:lower():gsub("['’]", ""):gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
  local path = blog .. "/" .. slug .. ".smd"
  if vim.uv.fs_stat(path) then
    vim.cmd.edit(path)
    return vim.notify(slug .. ".smd already exists", vim.log.levels.WARN)
  end

  local snippets = vim.json.decode(table.concat(vim.fn.readfile(vim.fn.stdpath("config") .. "/snippets/supermd.json"), "\n"))
  local body = table.concat(snippets.post.body, "\n")
    :gsub("%${1:Title}", (title:gsub('"', '\\"'):gsub("%%", "%%%%")))
    :gsub("%$CURRENT_YEAR", os.date("%Y"))
    :gsub("%$CURRENT_MONTH", os.date("%m"))
    :gsub("%${CURRENT_DATE}", os.date("%d"))

  vim.cmd.edit(path)
  vim.snippet.expand(body)
end

vim.api.nvim_create_user_command("NewPost", function(opts)
  if opts.args ~= "" then
    return new_post(opts.args)
  end
  vim.ui.input({ prompt = "Post title: " }, function(title)
    if title and title ~= "" then
      new_post(title)
    end
  end)
end, { nargs = "?", desc = "New benomahony.com blog post" })

vim.keymap.set("n", "<leader>np", "<cmd>NewPost<cr>", { desc = "New blog post" })
