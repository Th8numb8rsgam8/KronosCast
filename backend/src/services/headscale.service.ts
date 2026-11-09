import { ENV } from '../config/env';
import { PreAuthKeyResponse } from '../types/device.types';

export const createHeadscaleUser = async (username: string): Promise<boolean> => {
	try {
		const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ name: username })
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 409 || errorText.includes('already exists')) {
				console.warn(`User ${username} already exists on Headscale.`);
				return true;
			}
			throw new Error(`Failed to create user: ${response.status} - ${errorText}`);
		}

		console.log(`Successfully created Headscale user: ${username}`);
		return true;
	} catch (error) {
		console.error('Error creating Headscale User:', error);
		return false;
	}
}

export const generateHeadscalePreauthKey = async (username: string, tag: string): Promise<string> => {

	const headscaleUsers = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
			'Content-Type': 'application/json'
		}
	});

	if (!headscaleUsers.ok) {
		throw new Error(`Failed to fetch Headscale users list: ${headscaleUsers.status}`);
	}
	const userData = (await headscaleUsers.json()) as { users: Array<{ id: number; name: string }> };
	const matchedUser = userData.users.find((u) => u.name === username);

	if (!matchedUser) {
		throw new Error(`Could not find numerid ID for Headscale user: ${username}`);
	}

	const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/preauthkey`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			user: matchedUser.id.toString(),
			reusable: false,
			ephemeral: false,
			expiration: new Date(Date.now() + 30 * 50 * 1000).toISOString(),
			aclTags: [tag],
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Headscale API error (${response.status}): ${errorBody}`);
	}

	const data = (await response.json()) as PreAuthKeyResponse;

	const key = data.preAuthKey?.key || data.key;
	if (!key) {
		throw new Error('Malformed response received from Headscale API: missing key.');
	}

	return key;
}

/**
 * Deletes a user from Headscale by their username (name).
 */
export const deleteHeadscaleUser = async (username: string): Promise<boolean> => {
	try {
		// 1. Fetch users to get the numeric ID matching the username
		const headscaleUsers = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			}
		});

		if (!headscaleUsers.ok) {
			throw new Error(`Failed to fetch Headscale users list: ${headscaleUsers.status}`);
		}

		const userData = (await headscaleUsers.json()) as { users: Array<{ id: number; name: string }> };
		const matchedUser = userData.users.find((u) => u.name === username);

		if (!matchedUser) {
			console.warn(`Headscale user '${username}' not found for deletion.`);
			return true; // Safe to ignore if already gone
		}

		// 2. Delete the user by their numeric ID
		const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user/${matchedUser.id}`, {
			method: 'DELETE',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to delete Headscale user: ${response.status} - ${errorText}`);
		}

		console.log(`Successfully deleted Headscale user: ${username} (ID: ${matchedUser.id})`);
		return true;
	} catch (error) {
		console.error('Error in deleteHeadscaleUser:', error);
		return false;
	}
};

/**
 * Finds a Headscale node by its hostname and deletes it using its numeric ID.
 */
export const deleteHeadscaleNodeByHostname = async (hostname: string): Promise<boolean> => {
	try {
		// 1. Fetch all nodes across the tailnet
		const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/node`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch Headscale nodes list: ${response.status}`);
		}

		const nodeData = (await response.json()) as { nodes: Array<{ id: string; givenName: string; name: string }> };
		
		// Match by either givenName or full name matching the hostname
		const matchedNode = nodeData.nodes?.find(
			(node) => node.givenName.includes(hostname) || node.name.includes(hostname)
		);

		if (!matchedNode) {
			console.warn(`Headscale node with hostname '${hostname}' not found for deletion.`);
			return true; // Safe to ignore if already deregistered
		}

		// 2. Delete the node by its string/numeric ID
		const deleteResponse = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/node/${matchedNode.id}`, {
			method: 'DELETE',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			}
		});

		if (!deleteResponse.ok) {
			const errorText = await deleteResponse.text();
			throw new Error(`Failed to delete Headscale node: ${deleteResponse.status} - ${errorText}`);
		}

		console.log(`Successfully deleted Headscale node: ${hostname} (ID: ${matchedNode.id})`);
		return true;
	} catch (error) {
		console.error('Error in deleteHeadscaleNodeByHostname:', error);
		return false;
	}
};
