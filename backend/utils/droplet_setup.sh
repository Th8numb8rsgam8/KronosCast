# 1. Create the new user (you will be prompted to set a password)
adduser sentinel

# 2. Grant the user sudo (admin) privileges
usermod -aG sudo sentinel 

# 1. Copy the SSH directory manually
cp -r ~/.ssh /home/sentinel/

# 2. Fix the ownership so the deploy user owns the files
chown -R sentinel:sentinel /home/sentinel/.ssh

# 4. Test the configuration by switching to the new user
su - sentinel

# 5. Verify sudo access (this should output "root")
sudo whoami

# sudo nano /etc/ssh/sshd_config

# Disable legacy challenge-response 
# ChallengeResponseAuthentication no

# Disable modern keyboard-interactive password prompts
# KbdInteractiveAuthentication no

# 1. Update the local package index and install prerequisite tools
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# 2. Add Docker's official GPG security key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 3. Set up the stable Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 4. Install the Docker Engine and the Docker Compose plugin
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin