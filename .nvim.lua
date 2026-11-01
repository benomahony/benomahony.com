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

	local snippets =
		vim.json.decode(table.concat(vim.fn.readfile(vim.fn.stdpath("config") .. "/snippets/supermd.json"), "\n"))
	local body = table
		.concat(snippets.post.body, "\n")
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

vim.keymap.set("n", "<leader>n", "<cmd>NewPost<cr>", { desc = "New blog post" })

vim.api.nvim_create_autocmd("BufWritePre", {
	pattern = blog .. "/*.smd",
	desc = "Set the date when a draft post is published",
	callback = function(args)
		local today = ('.date = .date("%sT00:00:00"),'):format(os.date("%Y-%m-%d"))
		local date_line
		for i, line in ipairs(vim.api.nvim_buf_get_lines(args.buf, 0, -1, false)) do
			if line == ".draft = true," or line == today then
				return
			end
			if not date_line and line:match('^%.date = %.date%(".*"%),$') then
				date_line = i
			end
		end
		if not date_line then
			return
		end
		local path = vim.api.nvim_buf_get_name(args.buf)
		local committed = vim.fn.system({ "git", "-C", vim.fs.dirname(path), "show", "HEAD:./" .. vim.fs.basename(path) })
		if vim.v.shell_error ~= 0 or not committed:find("\n%.draft = true,\n") then
			return
		end
		vim.api.nvim_buf_set_lines(args.buf, date_line - 1, date_line, false, { today })
		vim.notify("Published: date set to " .. os.date("%Y-%m-%d"))
	end,
})
