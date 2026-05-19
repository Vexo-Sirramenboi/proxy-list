# proxy-list
This is a complete list of lots of well known and probably working proxies. Check Releases for new versions of the list.

# Slowing Down Development
Development of the Proxy List will be slowed down as this tool won't be needed as much by users over the next few months. I am doing this to prioritize releasing ReBlock v2.0 for both macOS and Windows. If you have an active pull request/issue/Google Forms submission, it will likely not be implemented for a while. View the [ReBlock GitHub repo here](https://github.com/yourworstnightmare1/reblock).

# Share the list
Feel free to download the list and share it around! The list is also available at https://yourworstnightmare1.github.io/proxy-list/.

# Versioning info
The default version format is v[version]r[revision].
<br>
[version] uses standard semantic versioning. [revision] is updated each time a new link or change is made.

# Contributions
View [CONTRIBUTING.md](https://github.com/yourworstnightmare1/proxy-list/blob/main/CONTRIBUTING.md) for details on how to request links. You can also submit links on Google Forms if the Contributing Guide confuses you [here](https://forms.gle/NjWM3wQCKEAy6VKu6).
<br>
**I am only accepting contributions to list.md, I am not taking contributions on any code present here.**

# How is CAPTCHA tested?
CAPTCHA is tested using the official [Google ReCAPTCHA demo](https://www.google.com/recaptcha/api2/demo)

# When is the list updated?
**Automation**: The list is automatically checked every six hours. Each run re-checks HTTP for links in `list.md` and updates per-URL failure counts in `link_status.json`. After three consecutive failing runs for the same URL, that row is eligible to be removed from `list.md`. The scheduled workflow keeps purging **off** by default (`LINK_CHECK_NO_PURGE`, so flaky CI does not mass-delete working proxies); counters still advance. To have the bot purge dead links from the repo, set the Actions repository variable `LINK_CHECK_NO_PURGE` to `false`, or run `python scripts/link_checker.py` locally with that variable unset.\
**Manual**: I will periodically update the list if I find new proxies, or if someone makes a pull request and I approve.
